import { ACP_UNKNOWN_WORK, acpRelayOpenWork } from '../process/acp-relay-work-markers'
import type { AcpStructuredChild } from './children/acp-structured-child'

/**
 * The open work a detached agent's idle stop counts. OMP's, like its open-app idle, is unknown.
 * So is Droid's once it may have started a subagent (in this launch, or as an earlier one said):
 * those outlive their closed calls with no line the daemon reads, so it is carried as work nothing
 * ends. A turn the agent began itself has no end the daemon reads, so its running calls count, each
 * until its final status, as the open app keeps them running past the turn's quiet end.
 */
export function acpChildRelayOpenWork(
  session: AcpStructuredChild | undefined
): Record<string, string[][]> | null {
  const translator = session?.lane?.translator
  if (!translator || session.spec.agent === 'omp') {
    return null
  }
  const work = acpRelayOpenWork({
    tasks: [
      ...translator.backgroundTasks.runningIds,
      ...(translator.agentTurnCalls()?.ids() ?? [])
    ],
    subagents: translator.subagents.openIds
  })
  const droidUnknown =
    session.spec.agent === 'droid' &&
    (session.turns?.running !== false ||
      session.lane?.openTurnId !== null ||
      translator.subagents.anyStarted ||
      (session.connection.kept?.openWork(ACP_UNKNOWN_WORK).length ?? 0) > 0)
  return droidUnknown ? { ...work, [ACP_UNKNOWN_WORK]: [['subagent']] } : work
}
