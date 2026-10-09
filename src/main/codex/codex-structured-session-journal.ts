import type { AgentSessionAccountKind } from '../../shared/agent-session-availability'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { CodexDispatchEchoes } from './codex-structured-dispatch-echo'
import { createCodexJournalTranslator } from './codex-structured-journal-translation'
import type { CodexSubagentExecutions } from './codex-subagent-executions'
import type {
  CodexAcquisitionAttempt,
  CodexStructuredSessionAdapterDeps
} from './codex-structured-session-state'

export function createCodexSessionJournalTranslator(input: {
  sink: StructuredAgentSessionEventSink | undefined
  account: () => AgentSessionAccountKind | undefined
  sessionId: string
  acquisitionId: string
  deps: CodexStructuredSessionAdapterDeps
  primaryThreadId: () => string | null
  dispatchEchoes: CodexDispatchEchoes
  subagentExecutions: CodexSubagentExecutions
  prompts: CodexAcquisitionAttempt['window']['prompts']
}) {
  const { sink, account, sessionId, acquisitionId, deps, dispatchEchoes, prompts } = input
  return sink
    ? createCodexJournalTranslator({
        sink,
        account,
        sessionId,
        acquisitionId,
        ...(deps.now ? { now: deps.now } : {}),
        primaryThreadId: input.primaryThreadId,
        onPrimaryThreadStoppedRunning: () => deps.onPrimaryThreadStoppedRunning?.({ sessionId }),
        dispatchRequestOrigin: (clientMessageId) => dispatchEchoes.requestOrigin(clientMessageId),
        subagentExecutions: input.subagentExecutions,
        bindPromptItemId: (journalItemId, threadId, promptKey, turnId) =>
          prompts.bindJournalItemId(journalItemId, threadId, promptKey, turnId),
        clearPromptTurn: (threadId, turnId) => prompts.clearTurn(threadId, turnId),
        onUserMessageEcho: (clientMessageId, providerIdentity) => {
          // History echoes do not settle a send this session never admitted.
          if (dispatchEchoes.settle(clientMessageId)) {
            deps.onDispatchSettledLate?.({ sessionId, clientMessageId, providerIdentity })
          }
        }
      })
    : null
}
