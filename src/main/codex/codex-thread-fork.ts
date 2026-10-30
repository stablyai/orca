import { readCodexForkPermissions } from './codex-fork-permissions'
import { codexProviderHandle } from '../../shared/agent-session-provider-handle-encoding'
import { setImmediate } from 'node:timers/promises'
import { throwIfSignalAborted } from '../../shared/abort-signal-reason'
import type { AgentSessionProviderHandle } from '../../shared/agent-session-provider-handle'
import type { CodexStructuredPermissionPolicy } from '../../shared/codex-permission-policy'
import type { JournalReplacementItem } from '../native-chat/agent-session-journal/journal-epoch-replacement'
import type { StructuredAgentSessionTransitionJournal } from '../native-chat/agent-session-wire/structured-agent-session-transition'
import type { CodexAppServerConnection } from './app-server/codex-app-server-connection-types'
import { DEFAULT_CODEX_REQUEST_TIMEOUT_MS } from './codex-app-server-connection'
import { createCodexHistoryImportPlan } from './codex-history-import-plan'
import { discoverCodexHistory, loadCodexHistory } from './codex-structured-thread-history-pages'
import { readCodexJournalRecord } from './codex-structured-journal-translation-values'
import { readCodexThreadId } from './codex-structured-thread-facts'

type ForkHistoryInput = {
  connection: Pick<CodexAppServerConnection, 'request'>
  threadId: string
  lastTurnId: string
  sessionId: string
  signal?: AbortSignal
  timeoutMs?: number
}

/** Required founding import: every page and the inclusive endpoint must be proven. */
export async function readRequiredCodexForkHistory(
  input: ForkHistoryInput
): Promise<JournalReplacementItem[]> {
  const signal = input.signal ?? new AbortController().signal
  const deadline = Date.now() + (input.timeoutMs ?? DEFAULT_CODEX_REQUEST_TIMEOUT_MS)
  const check = () => {
    throwIfSignalAborted(signal)
    if (Date.now() >= deadline) {
      throw new Error('Codex branch history read timed out.')
    }
  }
  const journal: StructuredAgentSessionTransitionJournal = {
    epoch: 'fork-import',
    visitItems: () => {},
    visitItemsWithLinkage: () => {},
    itemBody: () => null,
    item: () => null,
    canonicalItemId: (id) => id
  }
  const read = { ...input, signal, deadline, check }
  const missing = await discoverCodexHistory(read, {
    epoch: journal.epoch,
    nativePromptKeys: new Set(),
    known: new Set(),
    latest: null,
    latestPosition: null,
    hasRows: false,
    importedAt: null,
    unresolvedOrigin: false
  })
  const staging = createCodexHistoryImportPlan({
    sessionId: input.sessionId,
    threadId: input.threadId,
    journal,
    nativePromptKeys: new Set(),
    check
  })
  try {
    let last: Record<string, unknown> | undefined
    for await (const turn of loadCodexHistory(read, missing.pages)) {
      staging.restore(turn)
      last = turn
      await setImmediate()
    }
    if (last?.id !== input.lastTurnId || last.status !== 'completed') {
      throw new Error('Codex did not preserve the requested completed branch cut point.')
    }
    return staging.finish().mutations.map((mutation): JournalReplacementItem => {
      if (mutation.kind !== 'item') {
        throw new Error('Unexpected Codex branch history tombstone.')
      }
      return {
        identity: mutation.identity,
        body: mutation.body,
        turnScope: mutation.turnScope,
        ownerFence: 0,
        ...mutation.linkage,
        ...(mutation.observedAt === undefined ? {} : { observedAt: mutation.observedAt })
      }
    })
  } finally {
    staging.dispose()
  }
}

export async function forkCodexThread(
  input: ForkHistoryInput & {
    cwd: string
    permissionPolicy?: CodexStructuredPermissionPolicy
    ownPermissionHome?: string
    options?: Readonly<Record<string, string>>
    beforeFork: () => Promise<void>
  }
): Promise<{
  providerHandle: AgentSessionProviderHandle
  items: JournalReplacementItem[]
  options: Readonly<Record<string, string>>
}> {
  throwIfSignalAborted(input.signal)
  const parent = readCodexJournalRecord(
    readCodexJournalRecord(
      await input.connection.request(
        'thread/read',
        { threadId: input.threadId, includeTurns: false },
        { timeoutMs: input.timeoutMs }
      )
    ).thread
  )
  if (parent.id !== input.threadId) {
    throw new Error('The parent Codex conversation is unavailable.')
  }
  const options = {
    ...(typeof parent.model === 'string' ? { model: parent.model } : {}),
    ...(typeof parent.reasoningEffort === 'string' ? { effort: parent.reasoningEffort } : {}),
    ...input.options
  }
  const permission = input.ownPermissionHome
    ? await readCodexForkPermissions({
        accountHome: input.ownPermissionHome,
        threadId: input.threadId,
        path: parent.path,
        signal: input.signal
      })
    : input.permissionPolicy
  const config = {
    ...(permission && 'config' in permission ? permission.config : {}),
    ...(options.effort ? { model_reasoning_effort: options.effort } : {})
  }
  await input.beforeFork()
  throwIfSignalAborted(input.signal)
  const result = await input.connection.request(
    'thread/fork',
    {
      threadId: input.threadId,
      lastTurnId: input.lastTurnId,
      cwd: input.cwd,
      excludeTurns: true,
      deferGoalContinuation: true,
      ...permission,
      ...(options.model ? { model: options.model } : {}),
      ...(typeof parent.modelProvider === 'string' ? { modelProvider: parent.modelProvider } : {}),
      ...(Object.keys(config).length ? { config } : {}),
      ...(input.options?.serviceTier ? { serviceTier: input.options.serviceTier } : {})
    },
    { timeoutMs: input.timeoutMs }
  )
  const threadId = readCodexThreadId(result)
  if (!threadId || threadId === input.threadId) {
    throw new Error('Codex did not return an independent branch conversation.')
  }
  const items = await readRequiredCodexForkHistory({ ...input, threadId })
  const reply = readCodexJournalRecord(result)
  return {
    providerHandle: codexProviderHandle(threadId),
    items,
    options: {
      ...options,
      ...(typeof reply.model === 'string' ? { model: reply.model } : {}),
      ...(typeof reply.reasoningEffort === 'string' ? { effort: reply.reasoningEffort } : {}),
      ...(typeof reply.serviceTier === 'string' ? { serviceTier: reply.serviceTier } : {})
    }
  }
}
