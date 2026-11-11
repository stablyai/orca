import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/host/structured-agent-session-logger'
import type { PiRpcSession } from './rpc-session'

export function closeFailedPiSession(
  session: Pick<PiRpcSession, 'close' | 'input'>,
  logger: StructuredAgentSessionLogger
): void {
  void session
    .close(false)
    .then((result) => {
      if (result.root !== 'exited' && !result.killDelivered) {
        logger.warn('Pi process exit is unverifiable', {
          scope: 'pi-stop',
          sessionId: session.input.identity.sessionId
        })
      }
    })
    .catch((cause: unknown) =>
      logger.error('Pi process cleanup failed', {
        scope: 'pi-stop',
        sessionId: session.input.identity.sessionId,
        error: cause
      })
    )
}
