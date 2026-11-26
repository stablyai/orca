import { codexMethodUnavailable } from './structured/catalog/codex-structured-applied-settings'
import { isCodexAppServerRequestError } from './app-server/codex-app-server-request-error'
import { join } from 'node:path'
import type { StructuredAgentSessionConversationCopyInput } from '../native-chat/agent-session-wire/providers/structured-agent-session-conversation-copy-input'
import { requireLegacyAgentSessionAccountHome } from '../../shared/agent-session/lifecycle/accounts/agent-session-account-home'
import { resolveSessionFilePath } from '../native-chat/session-file-resolver'
import { asRecord } from '../ai-vault/parsing/session-record-fields'
import { codexForkModelOverrides } from './codex-fork-model-overrides'
import { readCodexForkTurns } from './codex-fork-turns'
import { codexHistorySources } from '../native-chat/transcript-history/codex/codex-rollout-history-source'
import {
  AgentConversationCopyError,
  AgentConversationCopyStartError,
  agentConversationCopyRefusal
} from '../native-chat/conversation-adoption/agent-conversation-copy-error'
import {
  runCodexProviderAppServer,
  type CodexProviderInvocationDeps
} from './structured/session-lifecycle/codex-provider-session-rename'

/** Omitting a turn cut asks Codex to snapshot its current persisted context, including a running turn. */
export async function copyCurrentCodexConversation(
  input: StructuredAgentSessionConversationCopyInput,
  invocation: CodexProviderInvocationDeps | undefined
) {
  if (!input.record || !invocation) {
    throw new AgentConversationCopyError('Codex cannot copy this conversation on this host.')
  }
  const record = input.record
  const signal = AbortSignal.any([
    AbortSignal.timeout(60_000),
    ...(input.signal ? [input.signal] : [])
  ])
  const home = requireLegacyAgentSessionAccountHome(record.accountHome).path
  let dispatched = Boolean(input.copiedSessionId)
  try {
    return await runCodexProviderAppServer(
      record,
      {
        ...invocation,
        resolveLaunchArgs: () => record.launchArgs ?? invocation.resolveLaunchArgs()
      },
      { timeoutMs: 60_000, signal, experimentalApi: true },
      async (rpc, cwd) => {
        let fork: Record<string, unknown> | null = input.copiedSessionId
          ? { id: input.copiedSessionId }
          : null
        if (!fork) {
          const metadata = asRecord(
            asRecord(
              await rpc.request('thread/read', {
                threadId: input.providerSessionId,
                includeTurns: false
              })
            )?.thread
          )
          if (metadata?.id !== input.providerSessionId) {
            throw new AgentConversationCopyError('Codex could not verify the source chat.')
          }
          signal.throwIfAborted()
          rpc.signal?.throwIfAborted()
          dispatched = true
          fork = asRecord(
            asRecord(
              await rpc.request('thread/fork', {
                threadId: input.providerSessionId,
                excludeTurns: true,
                cwd,
                ...codexForkModelOverrides(record.options?.model, metadata)
              })
            )?.thread
          )
        }
        if (
          typeof fork?.id !== 'string' ||
          !fork.id.trim() ||
          fork.id === input.providerSessionId
        ) {
          throw new Error('Codex did not confirm an independent conversation.')
        }
        let remembered = false
        try {
          await input.onCopyConfirmed?.(fork.id)
          remembered = Boolean(input.onCopyConfirmed)
          try {
            if (!input.copiedCoverage) {
              await rpc.request('thread/goal/clear', { threadId: fork.id, origin: 'user' })
            }
          } catch (error) {
            if (
              !codexMethodUnavailable(error, 'thread/goal/clear') &&
              !(
                isCodexAppServerRequestError(error) &&
                error.method === 'thread/goal/clear' &&
                /(?:^|: )goals feature is disabled[.!]?$/i.test(error.message)
              )
            ) {
              throw error
            }
          }
          const filePath = await resolveSessionFilePath(
            'codex',
            fork.id,
            {
              codexSessionsDirs: [join(home, 'sessions'), join(home, 'archived_sessions')],
              strictErrors: true
            },
            signal
          )
          if (!filePath) {
            throw new Error('Codex could not find the copied conversation.')
          }
          const admitted = await codexHistorySources(filePath, [
            join(home, 'sessions'),
            join(home, 'archived_sessions')
          ])
          const coverage = input.copiedCoverage ?? {
            unit: 'codex-turn' as const,
            ids: (await readCodexForkTurns(rpc, fork.id, Infinity)).map((turn) => turn.id)
          }
          return { sessionId: fork.id, filePath: admitted.path, coverage }
        } catch (error) {
          let archived = false
          try {
            if (!remembered) {
              await rpc.request('thread/archive', { threadId: fork.id }, { timeoutMs: 5_000 })
              archived = true
            }
          } catch {
            // Keep the confirmed id recoverable even if cleanup also loses its reply.
          }
          throw new AgentConversationCopyStartError(
            `Codex created chat ${fork.id}, but could not finish opening it. ${
              remembered
                ? 'Retry will reopen this saved copy.'
                : archived
                  ? 'The copy is in archived history.'
                  : 'Check this copy in Codex history.'
            } ${error instanceof Error ? error.message : 'Copy preparation failed.'}`
          )
        }
      }
    )
  } catch (error) {
    if (error instanceof AgentConversationCopyStartError) {
      throw error
    }
    const unsupported =
      codexMethodUnavailable(error, 'thread/read') || codexMethodUnavailable(error, 'thread/fork')
    const unsaved =
      isCodexAppServerRequestError(error) &&
      (error.method === 'thread/read' || error.method === 'thread/fork') &&
      error.code === -32600 &&
      error.message.endsWith(`no rollout found for thread id ${input.providerSessionId}`)
    if (!dispatched || unsupported || unsaved) {
      const refusal = unsupported
        ? agentConversationCopyRefusal(
            'structured_agent_session_unsupported',
            { reason: 'hostUnsupported' },
            'This Codex version cannot copy the current context. Update Codex, then try again.'
          )
        : agentConversationCopyRefusal(
            'agent_session_operation_invalid',
            { reason: 'providerRejected' },
            unsaved
              ? 'This chat has no saved Codex context yet. Send a message first, then open a side chat.'
              : 'Codex could not read the source conversation. Open it again, then try again.'
          )
      refusal.refusal.createAttemptRefusedBeforeCommit = true
      throw refusal
    }
    if (dispatched) {
      throw new AgentConversationCopyStartError(
        error instanceof Error ? error.message : 'Codex could not confirm the copy.'
      )
    }
    throw error
  }
}
