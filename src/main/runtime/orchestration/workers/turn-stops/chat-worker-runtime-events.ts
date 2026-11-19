import type { OrcaRuntimeWithGetPtyRecordForPaneKey } from '../../mailbox/routing/terminal-pane-mail-routing'
import { escalateChatWorkerError } from './chat-worker-error-escalation'
import type {
  StructuredAgentSessionIdleDeath,
  StructuredAgentSessionRequestFailure
} from '../../../../native-chat/agent-session-wire/observations/structured-agent-session-request-failures'
import type { AdmittedMessage } from '../../../../native-chat/agent-session-wire/host/structured-agent-session-host-types'
import { reportChatWorkerProviderDeath } from './chat-worker-provider-death'
import { RuntimeStructuredAgentHost } from '../../../agent-session/installation/runtime-structured-agent-host'

export abstract class RuntimeChatWorkerEvents extends RuntimeStructuredAgentHost {
  abstract onStructuredSessionStatusForMail(
    ...args: Parameters<OrcaRuntimeWithGetPtyRecordForPaneKey['onStructuredSessionStatusForMail']>
  ): ReturnType<OrcaRuntimeWithGetPtyRecordForPaneKey['onStructuredSessionStatusForMail']>

  abstract onStructuredSessionTabHidden(
    ...args: Parameters<OrcaRuntimeWithGetPtyRecordForPaneKey['onStructuredSessionTabHidden']>
  ): ReturnType<OrcaRuntimeWithGetPtyRecordForPaneKey['onStructuredSessionTabHidden']>

  abstract structuredChatMailOwed(
    ...args: Parameters<OrcaRuntimeWithGetPtyRecordForPaneKey['structuredChatMailOwed']>
  ): ReturnType<OrcaRuntimeWithGetPtyRecordForPaneKey['structuredChatMailOwed']>

  /** A message a chat took; the connector seam keeps its turn's source for the chat's thread. */
  abstract onChatMessageAdmitted(message: AdmittedMessage): void

  /** A chat worker whose request settled failed tells the Run that dispatched it; a bot, its senders. */
  onStructuredRequestFailureForErrorMail(failure: StructuredAgentSessionRequestFailure): void {
    void escalateChatWorkerError(failure, this.workerTurnStopReportDeps)
    this.botSessions.requestFailed(failure)
  }

  /** A chat worker whose provider died between turns tells the Run that dispatched it. */
  onStructuredIdleProviderDeathForMail(death: StructuredAgentSessionIdleDeath): void {
    reportChatWorkerProviderDeath(death, this.workerTurnStopReportDeps)
  }
}
