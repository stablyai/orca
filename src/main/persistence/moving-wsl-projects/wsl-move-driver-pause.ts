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

const sessionsOf = (panes: readonly WslMoveRestoreHintPane[]): string =>
  JSON.stringify(panes.map((pane) => pane.sessionId).sort())

export async function pauseWslMoveScope(
  deps: Pick<WslMoveDriverDeps, 'gateInputs' | 'listPanes' | 'quiesce'>,
  scope: WslMoveTerminalScope
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
  try {
    const { failedWorktreeIds } = await deps.quiesce.sleepWorkspaces(scope.workspaceIds)
    return failedWorktreeIds.length > 0
      ? refusal('wsl_move_pause_failed', { detail: 'sleep-failed' })
      : { panes }
  } catch (error) {
    return refusal('wsl_move_pause_failed', {
      detail: error instanceof Error ? error.message : String(error)
    })
  }
}
