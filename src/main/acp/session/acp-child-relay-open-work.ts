import { ACP_UNKNOWN_WORK, acpRelayOpenWork } from '../process/acp-relay-work-markers'
import { isAcpReadySession, type AcpStructuredChild } from './children/acp-structured-child'

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

/** See `StructuredAgentSessionAdapter.keptLaunchOutgrown`; only a ready chat's kept agent answers. */
export async function acpChildKeptLaunchOutgrown(
  session: AcpStructuredChild | undefined,
  toolsOutdated: boolean,
  owesWork: () => Promise<boolean>
): Promise<boolean | 'pending' | undefined> {
  const kept = isAcpReadySession(session) ? session.connection.kept : null
  // OMP's background work is invisible here (above), so no tools refresh, this one or Orca's
  // ordinary comparison, ends its kept agent: it keeps the tools it has.
  if (session?.spec.agent === 'omp') {
    return kept ? false : undefined
  }
  // A kept agent waits for its replay only when a tools refresh could follow (one owing a fresh
  // agent, or the host's tools changed since launch) and it owes no work that would keep it.
  if (kept && (kept.freshOwed || toolsOutdated)) {
    if (await owesWork()) {
      return false
    }
    await kept.replaySettled()
  }
  return kept?.launchOutgrown
}
