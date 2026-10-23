import { resolveEarlyPaneKey as resolvePaneCoordinates } from '../spawn-pane-coordinates'
import { resolveAgentLaunchPaneVerdict } from '../../../agent-launch/agent-launch-pane-attachment'
import { AGENT_LAUNCH_PANE_REFUSED_CODE } from '../../../../shared/agent-launch-pane-verdict'
import { agentLaunchPaneLiveness } from '../pane/agent-launch-pane-evidence'
import { makePaneSpawnReservationKey } from '../pane/spawn-reservation'
import type { PtyIpcSpawnState } from './spawn-state'
import type { PtySpawnIpcArgs } from './spawn-types'

/** The pane key a spawn names before preflight; null when it names no stable pane. */
export function resolveEarlyPaneKey(args: PtySpawnIpcArgs): string | null {
  return typeof args.worktreeId === 'string' ? resolvePaneCoordinates(args) : null
}

export function resolveEarlyPaneSpawnReservationKey(args: PtySpawnIpcArgs): string | null {
  return makePaneSpawnReservationKey(args.worktreeId, args.connectionId, resolveEarlyPaneKey(args))
}

export async function checkPtyIpcLaunchPane(ctx: PtyIpcSpawnState): Promise<void> {
  const args = ctx.args
  // A pane an agent launch laid out attaches to its agent or says why it can't, never runs a shell.
  // A replacing spawn already holds the pane: the user restarted it, and that is theirs to run.
  const launchPaneKey = ctx.paneSpawnReservation ? null : resolveEarlyPaneKey(args)
  const launchVerdict =
    launchPaneKey && args.worktreeId && args.tabId && args.leafId
      ? resolveAgentLaunchPaneVerdict(
          { worktreeId: args.worktreeId, paneKey: launchPaneKey },
          agentLaunchPaneLiveness(ctx.deps, {
            worktreeId: args.worktreeId,
            tabId: args.tabId,
            leafId: args.leafId,
            connectionId: args.connectionId
          })
        )
      : null
  if (launchVerdict && args.worktreeId && args.tabId && args.leafId) {
    const verdict = await launchVerdict
    // The window keeps a final verdict on the tab, clears a settled one, takes a withdrawn pane back.
    ctx.deps.runtime?.reportAgentLaunchPaneVerdict?.(
      { worktreeId: args.worktreeId, tabId: args.tabId, leafId: args.leafId },
      verdict
    )
    if (verdict.kind !== 'proceed') {
      throw new Error(AGENT_LAUNCH_PANE_REFUSED_CODE)
    }
  }
}
