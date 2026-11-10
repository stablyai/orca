import { TEXT_GENERATION_FAILURE_COPY } from '../../shared/text-generation-failure-copy'
import { codexForkHistory } from './codex-fork-history'
import {
  AgentConversationCopyError,
  AgentConversationCopyStartError,
  agentConversationCopyRefusal
} from '../native-chat/agent-conversation-copy-error'
import { isAgentSessionRefusalError } from '../../shared/agent-session/failures/agent-session-wire-refusals'
import { join } from 'node:path'
import { requireLegacyAgentSessionAccountHome } from '../../shared/agent-session/lifecycle/agent-session-account-home'
import { parseAgentJournalItemKey } from '../../shared/agent-session/journal/agent-session-journal-item-key'
import { asRecord } from '../ai-vault/session-scanner-values'
import type { StructuredAgentSessionAdapter } from '../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import { resolveSessionFilePath } from '../native-chat/session-file-resolver'
import {
  isCodexAppServerUnsupportedError,
  type CodexAppServerRpc
} from './app-server/codex-app-server-session'
import {
  runCodexProviderAppServer,
  type CodexProviderInvocationDeps
} from './structured/session-lifecycle/codex-provider-session-rename'

type CopyInput = Parameters<NonNullable<StructuredAgentSessionAdapter['copyConversation']>>[0]

function unavailable(): never {
  throw new AgentConversationCopyError('Codex could not verify the copied chat.')
}

async function turns(
  rpc: CodexAppServerRpc,
  threadId: string,
  through: number | string
): Promise<{ id: string; status?: unknown }[]> {
  const all: { id: string; status?: unknown }[] = []
  let cursor: string | null = null
  const seen = new Set<string>()
  do {
    const page = asRecord(
      await rpc.request('thread/turns/list', {
        threadId,
        cursor,
        sortDirection: 'asc',
        limit: 100,
        itemsView: 'summary'
      })
    )
    if (!Array.isArray(page?.data)) {
      return unavailable()
    }
    for (const raw of page.data) {
      const turn = asRecord(raw)
      if (typeof turn?.id !== 'string') {
        return unavailable()
      }
      all.push({ id: turn.id, status: turn.status })
      if (turn.id === through) {
        return all
      }
    }
    if (page.nextCursor != null && (typeof page.nextCursor !== 'string' || !page.nextCursor)) {
      return unavailable()
    }
    cursor = typeof page.nextCursor === 'string' ? page.nextCursor : null
    if (cursor && seen.has(cursor)) {
      return unavailable()
    }
    if (cursor) {
      seen.add(cursor)
    }
  } while (cursor && (typeof through === 'string' || all.length < through))
  return all
}

export async function copyCodexConversation(
  input: CopyInput,
  invocation: CodexProviderInvocationDeps | undefined
) {
  let starting = false
  let dispatched = false
  try {
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
    const legacy = parseAgentJournalItemKey(checkpoint.selectedItemId)?.provider === 'legacy'
    const find = async (id: string) =>
      (await resolveSessionFilePath(
        'codex',
        id,
        { codexSessionsDirs: stores, strictErrors: true },
        signal
      )) ?? unavailable()
    const physicalHistory = async (turnId: string | undefined) => {
      const path = await find(input.providerSessionId)
      return codexForkHistory({
        path,
        roots: stores,
        selectedItemId: checkpoint.selectedItemId,
        turnId,
        sessionId: input.providerSessionId,
        signal
      })
    }
    const missing = (): never => {
      throw agentConversationCopyRefusal(
        'agent_session_operation_invalid',
        { reason: 'savedConversationMissing' },
        'Codex could not find this response in the saved chat. Open the chat again, then fork a response still in its history.'
      )
    }
    let history = legacy && !checkpoint.turnId ? await physicalHistory(undefined) : undefined
    starting = true
    return await runCodexProviderAppServer(
      record,
      {
        ...invocation,
        resolveLaunchArgs: () => record.launchArgs ?? invocation.resolveLaunchArgs()
      },
      { timeoutMs: 60_000, signal, experimentalApi: true },
      async (rpc, cwd) => {
        starting = false
        let metadata
        try {
          metadata = asRecord(
            asRecord(
              await rpc.request('thread/read', {
                threadId: input.providerSessionId,
                includeTurns: false
              })
            )?.thread
          )
          if (
            metadata?.id !== input.providerSessionId ||
            (metadata.historyMode != null &&
              metadata.historyMode !== 'legacy' &&
              metadata.historyMode !== 'paginated')
          ) {
            throw new Error('Invalid source metadata')
          }
        } catch (error) {
          if (!isCodexAppServerUnsupportedError(error)) {
            throw error
          }
        }
        let native = metadata?.historyMode === 'paginated'
        let sourceTurns =
          native && checkpoint.turnId
            ? await turns(rpc, input.providerSessionId, checkpoint.turnId)
            : undefined
        if (!native || !sourceTurns || sourceTurns.at(-1)?.id !== checkpoint.turnId) {
          if (native && !legacy) {
            return missing()
          }
          history ??= await physicalHistory(native && legacy ? undefined : checkpoint.turnId)
          if (native && history.selected.id) {
            sourceTurns = await turns(rpc, input.providerSessionId, history.selected.id)
            if (sourceTurns.at(-1)?.id !== history.selected.id) {
              return missing()
            }
          } else {
            native = false
          }
        }
        const lastTurnId = native ? sourceTurns!.at(-1)!.id : history!.selected.id
        const beforeTurnId = native ? undefined : history!.roots[history!.index + 1]?.id
        const terminal = native
          ? ['completed', 'failed', 'interrupted'].includes(String(sourceTurns!.at(-1)?.status))
          : history!.selected.terminal
        if (!checkpoint.settled && !terminal && !beforeTurnId) {
          throw agentConversationCopyRefusal(
            'agent_session_operation_invalid',
            { reason: 'turnActive' },
            "Codex hasn't finished this response yet. Wait for it to finish, then try again."
          )
        }
        const prefix = native ? sourceTurns! : history!.roots.slice(0, history!.index + 1)
        sourceTurns = native
          ? sourceTurns!
          : prefix.every((root) => root.id)
            ? prefix.map((root) => ({ id: root.id! }))
            : await turns(rpc, input.providerSessionId, history!.roots.length)
        if (
          sourceTurns.length < prefix.length ||
          prefix.some((root, index) => root.id && root.id !== sourceTurns![index]?.id)
        ) {
          return missing()
        }
        const coverage = {
          unit: 'codex-turn' as const,
          ids: sourceTurns.slice(0, prefix.length).map((turn) => turn.id)
        }
        rpc.signal?.throwIfAborted()
        signal.throwIfAborted()
        dispatched = true
        const fork = asRecord(
          await rpc.request('thread/fork', {
            threadId: input.providerSessionId,
            ...(lastTurnId ? { lastTurnId } : beforeTurnId ? { beforeTurnId } : {}),
            excludeTurns: true,
            cwd: input.destinationCwd ?? cwd
          })
        )
        const thread = asRecord(fork?.thread)
        const id = thread?.id
        if (typeof id !== 'string' || !id.trim() || id === input.providerSessionId) {
          return unavailable()
        }
        if (native) {
          const captured = await turns(rpc, id, lastTurnId!)
          if (
            captured.length !== coverage.ids.length ||
            captured.some((turn, index) => turn.id !== coverage.ids[index])
          ) {
            return unavailable()
          }
          return { sessionId: id, coverage }
        }
        const captured = await codexForkHistory({
          path: await find(id),
          roots: stores,
          selectedItemId: checkpoint.selectedItemId,
          turnId: checkpoint.turnId,
          sessionId: id,
          inheritedOnly: true,
          signal
        })
        if (
          captured.index !== history!.index ||
          captured.roots.length < prefix.length ||
          captured.roots
            .slice(0, prefix.length)
            .some((root, index) => root.id && root.id !== coverage.ids[index])
        ) {
          return unavailable()
        }
        if (lastTurnId || beforeTurnId) {
          if (captured.roots.length !== prefix.length) {
            return unavailable()
          }
        } else {
          // Trim the actual capture; coverage identities were frozen on the source before fork.
          if (thread?.historyMode !== 'paginated') {
            return unavailable()
          }
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
        return { sessionId: id, coverage }
      }
    )
  } catch (error) {
    input.signal?.throwIfAborted()
    if (!dispatched) {
      const refusal = isAgentSessionRefusalError(error)
        ? error
        : agentConversationCopyRefusal(
            'agent_session_identity_required',
            { reason: 'transcriptUnreadable' },
            starting
              ? TEXT_GENERATION_FAILURE_COPY.agentCouldNotStart.replace('{{label}}', 'Codex')
              : 'Codex could not read the saved chat. Open it again, then try forking the response.'
          )
      if (starting) {
        refusal.cause = new AgentConversationCopyStartError(refusal.refusal.message)
      }
      refusal.refusal.createAttemptRefusedBeforeCommit = true
      throw refusal
    }
    if (error instanceof AgentConversationCopyError) {
      throw error
    }
    throw new AgentConversationCopyError('Codex could not verify the copied chat.', {
      cause: error
    })
  }
}
