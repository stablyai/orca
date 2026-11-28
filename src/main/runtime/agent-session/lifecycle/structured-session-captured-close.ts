import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-host'
import type { StructuredAgentSessionCloseCause } from '../../../native-chat/agent-session-wire/termination/structured-agent-session-host-lifetime'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { runsForBot } from '../../../bots/bot-session-tabs'
import {
  retireCapturedStructuredSessionSurface,
  structuredSessionSurfaceIsCurrent,
  type StructuredSessionSurface,
  type StructuredSessionSurfaceRuntime
} from './structured-agent-session-close'

/** Phone closes and cancelled creates admit the captured surface before stopping its provider. */
export async function closeCapturedStructuredSession(
  host: StructuredAgentSessionHost,
  sessionId: string,
  cause: StructuredAgentSessionCloseCause,
  surface: StructuredSessionSurface | null,
  runtime: StructuredSessionSurfaceRuntime & Partial<Pick<OrcaRuntimeService, 'bots'>>
): Promise<boolean> {
  if (surface && !structuredSessionSurfaceIsCurrent(host, sessionId, surface, runtime)) {
    return false
  }
  // A bot's thread or run keeps working when its tab closes; it waits in the bot's Activity.
  const keepRunning =
    cause === 'user-close' && runtime.bots !== undefined && runsForBot(runtime.bots, sessionId)
  const result = await retireCapturedStructuredSessionSurface(
    host,
    sessionId,
    surface,
    runtime,
    keepRunning
  )
  if (
    surface &&
    !structuredSessionSurfaceIsCurrent(host, sessionId, surface, runtime, result.committed)
  ) {
    return false
  }
  if (!keepRunning) {
    await host.close(sessionId, cause)
  }
  return result.committed
}
