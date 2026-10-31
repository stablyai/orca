/**
 * The first Sleep of a move, before its snapshot is taken: nothing is fenced yet, so the gate runs
 * again right before it, and the panes it pauses are exactly the ones the gate just passed. A
 * terminal opened in between refuses the move rather than being slept without its folder.
 */
import type { WslMoveRefusal } from '../../../shared/wsl-move/wsl-move-driver-types'
import type { WslMoveDriverDeps, WslMoveTerminalScope } from './wsl-move-driver-ports'
import { refusal } from './wsl-move-driver-plan'
import type { WslMoveRestoreHintPane } from './wsl-move-restore-hints'
import { assessWslMoveTerminals } from './wsl-move-terminal-gate'
import { withSleptSessionPanes } from './wsl-move-slept-scrollback'
import { sleepUntilPaused } from './wsl-move-quiesce'

const sessionsOf = (panes: readonly WslMoveRestoreHintPane[]): string =>
  JSON.stringify(panes.map((pane) => pane.sessionId).sort())

export async function pauseWslMoveScope(
  deps: Pick<
    WslMoveDriverDeps,
    'gateInputs' | 'listPanes' | 'quiesce' | 'sleptSessionPanes' | 'shellCwds'
  >,
  scope: WslMoveTerminalScope,
  /** The window's bindings of panes slept before the move, which main no longer holds. */
  reported: readonly WslMoveRestoreHintPane[] = []
): Promise<{ panes: readonly WslMoveRestoreHintPane[] } | WslMoveRefusal> {
  const before = deps.listPanes(scope)
  const gate = assessWslMoveTerminals(await deps.gateInputs(scope))
  if (gate.verdict === 'blocked') {
    return refusal('wsl_move_terminals_blocked', { blockers: gate.blockers })
  }
  // Read before Sleep, since a slept pane no longer names its session; and unchanged since the gate.
  const panes = deps.listPanes(scope)
  if (sessionsOf(panes) !== sessionsOf(before)) {
    return refusal('wsl_move_pause_failed', { detail: 'terminals-changed' })
  }
  // Bash on the bridge reports no folder; once slept, its shell is gone and so is the folder.
  const cwds = await (deps.shellCwds?.(panes) ?? Promise.resolve(new Map<string, string>())).catch(
    () => new Map<string, string>()
  )
  const withCwds = panes.map((pane) => {
    const shellCwd = cwds.get(pane.paneKey)
    return shellCwd ? { ...pane, shellCwd } : pane
  })
  try {
    const failedWorktreeIds = await sleepUntilPaused(deps.quiesce, scope.workspaceIds)
    // Panes slept before the move too, so their folders reach the restore hints, not only history.
    return failedWorktreeIds.length > 0
      ? refusal('wsl_move_pause_failed', { detail: 'sleep-failed' })
      : {
          panes: withSleptSessionPanes(
            withCwds,
            deps.sleptSessionPanes?.(scope.workspaceIds, reported) ?? []
          )
        }
  } catch (error) {
    return refusal('wsl_move_pause_failed', {
      detail: error instanceof Error ? error.message : String(error)
    })
  }
}
