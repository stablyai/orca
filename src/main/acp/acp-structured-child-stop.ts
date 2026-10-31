import { isAcpReadySession, type AcpStructuredChild } from './acp-structured-child'
import type { AcpStructuredSession } from './acp-structured-session'
import type { AcpStructuredConnection } from './acp-structured-connection'
import type { AcpChildStops, AcpDialect } from './acp-dialects/acp-dialect'
import { AcpAgentError } from './acp-errors'
import type {
  AgentChildWorkStopAcknowledgement,
  AgentSessionBackgroundTaskStops
} from '../../shared/agent-child-work-stop-targets'
import { acpBackgroundTaskStopId } from './acp-background-task-child-work'
import { acpSubagentOutcome } from './acp-subagents'

type ChildStopResult = {
  cancelled: boolean
  stillRunning?: true
  acknowledged?: AgentChildWorkStopAcknowledgement
}
type SubagentStop = NonNullable<AcpDialect['subagentStop']>
type BackgroundTaskStop = NonNullable<AcpDialect['backgroundTaskStop']>

export const NO_ACP_CHILD_STOPS: AcpChildStops = { subagents: false, backgroundTasks: false }

export function acpChildStopCapabilities(
  session?: AcpStructuredChild
): AgentSessionBackgroundTaskStops | undefined {
  return session?.journalClosed === null
    ? {
        supportsTaskStop:
          isAcpReadySession(session) &&
          (session.childStops?.subagents === true || session.childStops?.backgroundTasks === true),
        supportsStopAll: false
      }
    : undefined
}

async function probeAcpSubagentStop(
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

/** Only an explicit unknown-route response hides Stop. */
async function probeAcpBackgroundTaskStop(
  connection: AcpStructuredConnection,
  dialect: AcpDialect
): Promise<boolean> {
  const control = dialect.backgroundTaskStop
  if (!control) {
    return false
  }
  try {
    await connection.requestExtension(control.probe.method, control.probe.params, 2_000)
    return true
  } catch (error) {
    return !(error instanceof AcpAgentError && control.lacksRoute(error))
  }
}

export async function probeAcpChildStops(
  connection: AcpStructuredConnection,
  dialect: AcpDialect
): Promise<AcpChildStops> {
  const [subagents, backgroundTasks] = await Promise.all([
    probeAcpSubagentStop(connection, dialect),
    probeAcpBackgroundTaskStop(connection, dialect)
  ])
  return { subagents, backgroundTasks }
}

async function stopAcpSubagent(
  session: AcpStructuredSession,
  control: SubagentStop,
  id: string
): Promise<ChildStopResult> {
  const request = control.request(session.lane.translator.providerSessionId, id)
  let value: unknown
  try {
    value = await session.connection.requestExtension(request.method, request.params)
  } catch (error) {
    // Grok reports missing subagents normally; a refusal proves no cancellation occurred.
    if (error instanceof AcpAgentError) {
      return { cancelled: false, stillRunning: true }
    }
    throw error
  }
  const result = control.response(value, id)
  if (result.state === 'working') {
    return { cancelled: result.cancelled }
  }
  // Missing is not accepted; a terminal state supplies its own outcome.
  const outcome = result.state === undefined ? undefined : acpSubagentOutcome(result.state)
  return result.cancelled || outcome !== undefined
    ? {
        cancelled: result.cancelled,
        acknowledged: { taskId: id, ...(outcome !== undefined ? { outcome } : {}) }
      }
    : { cancelled: false }
}

async function stopAcpBackgroundTask(
  session: AcpStructuredSession,
  control: BackgroundTaskStop,
  taskId: string
): Promise<ChildStopResult> {
  const request = control.request(session.lane.translator.providerSessionId, taskId)
  let value: unknown
  try {
    value = await session.connection.requestExtension(request.method, request.params)
  } catch (error) {
    // Grok reports missing tasks normally; a refusal proves nothing was killed.
    if (error instanceof AcpAgentError) {
      return { cancelled: false, stillRunning: true }
    }
    throw error
  }
  const outcome = control.response(value, taskId)
  if (outcome === 'refused') {
    return { cancelled: false, stillRunning: true }
  }
  // Settle missing tasks now; later provider completion replaces this with its actual result.
  if (outcome === 'gone') {
    session.lane.apply(session.lane.translator.reconcileBackgroundTask(taskId))
  }
  return { cancelled: true }
}

/** Handles come from the host's authoritative stoppable-child records. */
export async function stopAcpChildren(
  session: AcpStructuredSession,
  fence: number,
  taskIds: readonly string[],
  acknowledge: (acknowledgement: AgentChildWorkStopAcknowledgement) => void = () => {}
): Promise<{ cancelled: boolean; stillRunning?: true }> {
  const subagentStop = session.childStops?.subagents ? session.spec.dialect.subagentStop : undefined
  const taskStop = session.childStops?.backgroundTasks
    ? session.spec.dialect.backgroundTaskStop
    : undefined
  const routed = (id: string) =>
    acpBackgroundTaskStopId(id) === undefined ? subagentStop !== undefined : taskStop !== undefined
  if (session.fence !== fence || (!subagentStop && !taskStop) || !taskIds.every(routed)) {
    throw new Error('ACP child cancellation is unavailable')
  }
  let cancelled = false
  let stillRunning = false
  for (const id of taskIds) {
    const taskId = acpBackgroundTaskStopId(id)
    const result: ChildStopResult =
      taskId !== undefined && taskStop
        ? await stopAcpBackgroundTask(session, taskStop, taskId)
        : subagentStop
          ? await stopAcpSubagent(session, subagentStop, id)
          : { cancelled: false }
    cancelled ||= result.cancelled
    stillRunning ||= result.stillRunning === true
    if (result.acknowledged) {
      acknowledge(result.acknowledged)
    }
  }
  return { cancelled, ...(stillRunning ? { stillRunning: true as const } : {}) }
}
