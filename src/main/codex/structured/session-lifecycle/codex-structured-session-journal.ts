import type { AgentSessionAccountKind } from '../../../../shared/agent-session/failures/agent-session-availability'
import type { StructuredAgentSessionEventSink } from '../../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import type { CodexDispatchEchoes } from '../turns/codex-structured-dispatch-echo'
import { createCodexJournalTranslator } from '../journal/codex-structured-journal-translation'
import type { CodexJournalTranslator } from '../journal/codex-structured-journal-contracts'
import type { CodexSubagentExecutions } from '../background-work/codex-subagent-executions'
import type {
  CodexAcquisitionAttempt,
  CodexStructuredSessionAdapterDeps
} from './codex-structured-session-state'
import {
  codexAcceptedSend,
  codexEchoVia
} from '../journal/codex-structured-journal-translation-turns'

export function createCodexSessionJournalTranslator(input: {
  sink: StructuredAgentSessionEventSink | undefined
  account: () => AgentSessionAccountKind | undefined
  localClock: boolean
  sessionId: string
  acquisitionId: string
  deps: CodexStructuredSessionAdapterDeps
  primaryThreadId: () => string | null
  dispatchEchoes: CodexDispatchEchoes
  subagentExecutions: CodexSubagentExecutions
  prompts: CodexAcquisitionAttempt['window']['prompts']
}): CodexJournalTranslator | null {
  const { sink, account, sessionId, acquisitionId, deps, dispatchEchoes, prompts } = input
  return sink
    ? createCodexJournalTranslator({
        sink,
        account,
        localClock: input.localClock,
        sessionId,
        acquisitionId,
        ...(deps.now ? { now: deps.now } : {}),
        primaryThreadId: input.primaryThreadId,
        dispatchEchoes,
        dispatchRequestOrigin: (clientMessageId) => dispatchEchoes.requestOrigin(clientMessageId),
        dispatchTurnOpener: (threadId, turnId) => dispatchEchoes.turnOpener(threadId, turnId),
        subagentExecutions: input.subagentExecutions,
        bindPromptItemId: (journalItemId, threadId, promptKey, turnId) =>
          prompts.bindJournalItemId(journalItemId, threadId, promptKey, turnId),
        clearPromptTurn: (threadId, turnId) => prompts.clearTurn(threadId, turnId),
        onUserMessageEcho: (clientMessageId, providerIdentity) => {
          // Read before settling: settling forgets how the send was written.
          const via = codexEchoVia(dispatchEchoes, clientMessageId, providerIdentity)
          // Duplicate exact echoes retry receipt persistence while the send remains unsettled.
          dispatchEchoes.settle(clientMessageId)
          deps.onDispatchSettledLate?.({
            sessionId,
            clientMessageId,
            ...codexAcceptedSend(sessionId, providerIdentity, via)
          })
        }
      })
    : null
}
