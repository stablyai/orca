import type { AcpStructuredSession } from './acp-structured-session'
import type { AcpStructuredConnection } from './acp-structured-connection'
import type { AcpChildStops, AcpDialect } from './acp-dialects/acp-dialect'
import { AcpAgentError } from './acp-errors'
import type { AgentSessionBackgroundTaskStops } from '../../shared/agent-child-work-stop-targets'
import { acpBackgroundTaskStopId } from './acp-background-task-child-work'

type ChildStopResult = { cancelled: boolean; stillRunning?: true }
type SubagentStop = NonNullable<AcpDialect['subagentStop']>
type BackgroundTaskStop = NonNullable<AcpDialect['backgroundTaskStop']>

export const NO_ACP_CHILD_STOPS: AcpChildStops = { subagents: false, backgroundTasks: false }

export function acpChildStopCapabilities(
  session?: AcpStructuredSession
): AgentSessionBackgroundTaskStops | undefined {
  return session?.journalClosed === null
    ? {
        supportsTaskStop:
          session.childStops?.subagents === true || session.childStops?.backgroundTasks === true,
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

/** Only the agent naming the route unknown hides Stop; any other answer leaves the Stop itself to
 *  report what happened. */
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
  id: string,
  at: () => number
): Promise<ChildStopResult> {
  const request = control.request(session.lane.translator.providerSessionId, id)
  let value: unknown
  try {
    value = await session.connection.requestExtension(request.method, request.params)
  } catch (error) {
    // Grok answers an ended or unknown subagent normally, so its refusal means it did nothing; anything else leaves the effect unknown.
    if (error instanceof AcpAgentError) {
      return { cancelled: false, stillRunning: true }
    }
    throw error
  }
  const result = control.response(value, id)
  if (result.state && result.state !== 'working') {
    session.lane.apply(session.lane.translator.reconcileSubagent(id, result.state, at()))
  }
  return { cancelled: result.cancelled }
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
    // Grok answers a task it no longer holds normally, so a refusal means it killed nothing.
    if (error instanceof AcpAgentError) {
      return { cancelled: false, stillRunning: true }
    }
    throw error
  }
  const outcome = control.response(value, taskId)
  if (outcome === 'refused') {
    return { cancelled: false, stillRunning: true }
  }
  // A killed task's own completion ends its row. A gone one settles here, and any completion
  // Grok still sends for it (exited but not yet swept) overwrites this with the real result.
  if (outcome === 'gone') {
    session.lane.apply(session.lane.translator.reconcileBackgroundTask(taskId))
  }
  return { cancelled: true }
}

/** The host has already resolved these handles from this parent's stoppable child records. */
export async function stopAcpChildren(
  session: AcpStructuredSession,
  fence: number,
  taskIds: readonly string[],
  at: () => number
): Promise<ChildStopResult> {
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
    const result =
      taskId !== undefined && taskStop
        ? await stopAcpBackgroundTask(session, taskStop, taskId)
        : subagentStop
          ? await stopAcpSubagent(session, subagentStop, id, at)
          : { cancelled: false }
    cancelled ||= result.cancelled
    stillRunning ||= result.stillRunning === true
  }
  return { cancelled, ...(stillRunning ? { stillRunning: true as const } : {}) }
}
