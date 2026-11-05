import { AgentConversationCopyError } from '../native-chat/agent-conversation-copy-error'
import { join } from 'node:path'
import { requireLegacyAgentSessionAccountHome } from '../../shared/agent-session/lifecycle/agent-session-account-home'
import { parseAgentJournalItemKey } from '../../shared/agent-session/journal/agent-session-journal-item-key'
import { asRecord, parseJsonObject } from '../ai-vault/session-scanner-values'
import type { StructuredAgentSessionAdapter } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { createLegacyIdentityTracker } from '../native-chat/agent-session-journal/journal-legacy-identity'
import { readCodexLocalHistory } from '../native-chat/codex-local-history'
import { resolveSessionFilePath } from '../native-chat/session-file-resolver'
import { decodeCodexTranscriptLine } from '../native-chat/transcript-line-decoders-codex'
import {
  runCodexAppServerSession,
  type CodexAppServerRpc
} from './app-server/codex-app-server-session'
import {
  codexProviderSessionInvocation,
  type CodexProviderSessionInvocationDeps
} from './codex-provider-session-invocation'

type CopyInput = Parameters<NonNullable<StructuredAgentSessionAdapter['copyConversation']>>[0]
type Root = { id?: string; terminal: boolean; prompt: boolean }

function unavailable(): never {
  throw new AgentConversationCopyError(
    'Codex could not locate an exact saved boundary for this response. Update Codex, then try again.'
  )
}

/** Use the importer's physical lineage and identity accounting, including discarded window rows. */
export async function codexForkHistory(input: {
  path: string
  roots: string[]
  selectedItemId: string
  turnId?: string
  sessionId: string
  signal?: AbortSignal
}) {
  const identity = parseAgentJournalItemKey(input.selectedItemId)
  const tracker = createLegacyIdentityTracker({
    transcriptAgent: 'codex',
    agent: 'codex',
    sessionId: input.sessionId
  })
  const roots: Root[] = []
  let selected: Root | undefined
  let lineIndex = 0
  await readCodexLocalHistory({
    filePath: input.path,
    roots: input.roots,
    visit: (line, fallbackId, _selected, recordId) => {
      input.signal?.throwIfAborted()
      const tracked = tracker.identify(line, lineIndex++)
      const raw = parseJsonObject(line)
      const payload = asRecord(raw?.payload)
      if (
        raw?.type === 'event_msg' &&
        payload?.type === 'thread_rolled_back' &&
        typeof payload.num_turns === 'number'
      ) {
        roots.splice(Math.max(0, roots.length - payload.num_turns))
        return
      }
      if (raw?.type === 'event_msg' && payload?.type === 'task_started') {
        roots.push({
          id: typeof payload.turn_id === 'string' ? payload.turn_id : undefined,
          terminal: false,
          prompt: false
        })
      }
      const message = decodeCodexTranscriptLine(line, fallbackId, { historyImport: true })
      if (message?.role === 'user') {
        const previous = roots.at(-1)
        if (!previous || (previous.prompt && (!previous.id || previous.terminal))) {
          roots.push({ terminal: false, prompt: true })
        } else {
          previous.prompt = true
        }
      }
      const root = roots.at(-1)
      if (
        root &&
        raw?.type === 'event_msg' &&
        (payload?.type === 'task_complete' || payload?.type === 'turn_aborted') &&
        (!payload.turn_id || payload.turn_id === root.id)
      ) {
        root.terminal = true
      }
      const importedMatch =
        identity?.provider === 'legacy' &&
        identity.recordId ===
          (recordId ?? (tracked.provider === 'legacy' ? tracked.recordId : undefined))
      if (
        root &&
        ((importedMatch && message?.role === 'assistant') ||
          (input.turnId && root.id === input.turnId))
      ) {
        if (selected && selected !== root) {
          return unavailable()
        }
        selected = root
      }
    }
  })
  const index = selected ? roots.indexOf(selected) : -1
  if (index < 0) {
    return unavailable()
  }
  return { roots, index, selected: roots[index] }
}

async function turns(
  rpc: CodexAppServerRpc,
  threadId: string,
  count: number
): Promise<{ id: string }[]> {
  const all: { id: string }[] = []
  let cursor: string | null = null
  const seen = new Set<string>()
  do {
    const page = asRecord(
      await rpc.request('thread/turns/list', { threadId, cursor, sortDirection: 'asc', limit: 100 })
    )
    if (!Array.isArray(page?.data)) {
      return unavailable()
    }
    for (const raw of page.data) {
      const turn = asRecord(raw)
      if (typeof turn?.id !== 'string') {
        return unavailable()
      }
      all.push({ id: turn.id })
    }
    cursor = typeof page.nextCursor === 'string' ? page.nextCursor : null
    if (cursor && seen.has(cursor)) {
      return unavailable()
    }
    if (cursor) {
      seen.add(cursor)
    }
  } while (cursor && all.length < count)
  return all
}

export async function copyCodexConversation(
  input: CopyInput,
  invocation: CodexProviderSessionInvocationDeps | undefined
) {
  if (!input.record || !input.checkpoint || !invocation) {
    return unavailable()
  }
  const { record, checkpoint } = input
  const signal = AbortSignal.any([
    AbortSignal.timeout(60_000),
    ...(input.signal ? [input.signal] : [])
  ])
  const home = requireLegacyAgentSessionAccountHome(record.accountHome).path
  const stores = [join(home, 'sessions'), join(home, 'archived_sessions')]
  const find = async (id: string) =>
    (await resolveSessionFilePath(
      'codex',
      id,
      { codexSessionsDirs: stores, strictErrors: true },
      signal
    )) ?? unavailable()
  const history = await codexForkHistory({
    path: await find(input.providerSessionId),
    roots: stores,
    selectedItemId: checkpoint.selectedItemId,
    turnId: checkpoint.turnId,
    sessionId: input.providerSessionId,
    signal
  })
  const launch = await codexProviderSessionInvocation(
    record,
    { ...invocation, resolveLaunchArgs: () => record.launchArgs ?? invocation.resolveLaunchArgs() },
    60_000
  )
  const beforeTurnId = history.roots[history.index + 1]?.id
  const lastTurnId = history.selected.id
  if (!checkpoint.settled && !history.selected.terminal && !beforeTurnId) {
    throw new AgentConversationCopyError(
      "Codex hasn't finished this response yet. Wait for it to finish, then try again."
    )
  }
  return runCodexAppServerSession(
    { ...launch, signal, experimentalApi: !lastTurnId && Boolean(beforeTurnId) },
    async (rpc) => {
      const fork = asRecord(
        await rpc.request('thread/fork', {
          threadId: input.providerSessionId,
          ...(lastTurnId ? { lastTurnId } : beforeTurnId ? { beforeTurnId } : {}),
          excludeTurns: true,
          cwd: launch.cwd
        })
      )
      const thread = asRecord(fork?.thread)
      const id = thread?.id
      if (typeof id !== 'string' || !id.trim() || id === input.providerSessionId) {
        return unavailable()
      }
      if (!lastTurnId && !beforeTurnId) {
        // Reconcile against the child's actual capture; a parent can grow while fork runs.
        if (thread?.historyMode !== 'paginated') {
          return unavailable()
        }
        const captured = await codexForkHistory({
          path: await find(id),
          roots: stores,
          selectedItemId: checkpoint.selectedItemId,
          turnId: checkpoint.turnId,
          sessionId: id,
          signal
        })
        const childTurns = await turns(rpc, id, captured.roots.length + 1)
        if (childTurns.length !== captured.roots.length) {
          return unavailable()
        }
        for (const [index, root] of captured.roots.entries()) {
          if (root.id && root.id !== childTurns[index]?.id) {
            return unavailable()
          }
        }
        const firstRemoved = childTurns[captured.index + 1]
        if (firstRemoved) {
          await rpc.request('thread/revert', { threadId: id, beforeTurnId: firstRemoved.id })
          const kept = await turns(rpc, id, captured.index + 2)
          if (
            kept.length !== captured.index + 1 ||
            kept.at(-1)?.id !== childTurns[captured.index]?.id
          ) {
            return unavailable()
          }
        }
      }
      return { sessionId: id }
    }
  )
}
