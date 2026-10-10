import type { AcpStructuredSession } from './acp-structured-session'
import type { AcpStructuredConnection } from './acp-structured-connection'
import type { AcpDialect } from './acp-dialects/acp-dialect'
import { AcpAgentError } from './acp-errors'
import type { AgentSessionBackgroundTaskStops } from '../../shared/agent-child-work-stop-targets'

export function acpChildStopCapabilities(
  session?: AcpStructuredSession
): AgentSessionBackgroundTaskStops | undefined {
  return session?.journalClosed === null
    ? { supportsTaskStop: session.subagentStopSupported === true, supportsStopAll: false }
    : undefined
}

export async function probeAcpChildStop(
  connection: AcpStructuredConnection,
  dialect: AcpDialect
): Promise<boolean> {
  const control = dialect.subagentStop
  if (!control) {
    return false
  }
  try {
    await connection.requestExtension(control.probe.method, control.probe.params, 2_000)
    return false
  } catch (error) {
    // The handler rejects the missing id before reaching its cancellation backend.
    return error instanceof AcpAgentError && control.recognizesProbeError(error)
  }
}

/** The host has already resolved these handles from this parent's stoppable child records. */
export async function stopAcpChildren(
  session: AcpStructuredSession,
  fence: number,
  taskIds: readonly string[],
  at: () => number
): Promise<{ cancelled: boolean; stillRunning?: true }> {
  const control = session.spec.dialect.subagentStop
  if (!control || !session.subagentStopSupported || session.fence !== fence) {
    throw new Error('ACP child cancellation is unavailable')
  }
  let cancelled = false
  let stillRunning = false
  for (const id of taskIds) {
    const request = control.request(session.lane.translator.providerSessionId, id)
    let value: unknown
    try {
      value = await session.connection.requestExtension(request.method, request.params)
    } catch (error) {
      // Grok answers an ended or unknown subagent normally, so its refusal means it did nothing; anything else leaves the effect unknown.
      if (error instanceof AcpAgentError) {
        stillRunning = true
        continue
      }
      throw error
    }
    const result = control.response(value, id)
    if (result.state && result.state !== 'working') {
      session.lane.apply(session.lane.translator.reconcileSubagent(id, result.state, at()))
    }
    cancelled ||= result.cancelled
  }
  return { cancelled, ...(stillRunning ? { stillRunning: true as const } : {}) }
}
