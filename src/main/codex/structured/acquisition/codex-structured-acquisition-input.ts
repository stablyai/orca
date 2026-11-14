import type { StructuredAgentSessionAcquireInput } from '../../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import type {
  CodexAcquisitionRegistry,
  CodexAcquisitionAttempt,
  CodexSession,
  CodexStructuredSessionAdapterDeps
} from '../session-lifecycle/codex-structured-session-state'
import type { CodexStructuredSessionTeardown } from '../session-lifecycle/codex-structured-session-teardown'
import type { CodexStructuredNotificationRetry } from '../session-lifecycle/codex-structured-notification-retry'
import type { deliverCodexServerRequest } from '../session-lifecycle/codex-structured-provider-events'

export type CodexStructuredAcquisitionInput = {
  input: StructuredAgentSessionAcquireInput
  deps: CodexStructuredSessionAdapterDeps
  sessions: Map<string, CodexSession>
  acquisitions: CodexAcquisitionRegistry
  notificationRetries: CodexStructuredNotificationRetry
  deliver: (
    acquisition: CodexAcquisitionAttempt['window'],
    sessionId: string,
    event: () => unknown,
    retainedBytes?: number
  ) => void
  handleServerRequest: (
    sessionId: string,
    request: Parameters<typeof deliverCodexServerRequest>[2]
  ) => void
  handleUnhandledFrame: (sessionId: string, kind: string, payload: unknown) => void
  forceCloseUnexpected: CodexStructuredSessionTeardown['forceCloseUnexpected']
  closeCompleted: CodexStructuredSessionTeardown['close']
}
