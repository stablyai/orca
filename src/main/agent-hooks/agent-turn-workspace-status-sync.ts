import type { AgentStatusState } from '../../shared/agent-status-types'
import type { AgentTurnOutcome } from '../../shared/agent-turn-outcome'
import type { WorkspaceStatus, WorkspaceStatusDefinition } from '../../shared/worktree/types'
import {
  DEFAULT_WORKSPACE_STATUS_ID,
  WORKSPACE_STATUS_IN_REVIEW_ID,
  WORKSPACE_STATUS_TODO_ID,
  isWorkspaceStatusId
} from '../../shared/workspace-statuses'

/**
 * Opt-in board behaviour: a session's turn boundary moves its workspace card between the
 * In progress and In review columns. The signal is the agent-status row the execution host
 * already resolves for every provider, never a raw hook event name, so a provider that spells
 * its boundary differently is not a special case here.
 */

export type AgentTurnWorkspaceStatusEvent = {
  paneKey: string
  tabId: string | undefined
  /** Agent-echoed worktree id; unreliable, used only as a fallback. */
  worktreeId: string | undefined
  /** The lead's own state, absent on providers that publish no lead record. */
  leadState: AgentStatusState | undefined
  /** Combined row state: child work can hold it open past the lead's own turn. */
  rowState: AgentStatusState
  /** Verdict on the turn the lead just closed; meaningful only while `leadState` is `done`. */
  leadOutcome: AgentTurnOutcome | undefined
  /** The row's `done` is a connect/resume/clear landing idle, not a completed turn. */
  sessionBoundary: boolean | undefined
  isReplay: boolean | undefined
  restoredUnconfirmed: boolean | undefined
  providerSessionOnly: boolean | undefined
}

export type AgentTurnWorkspaceStatusPane = {
  paneKey: string
  worktreeId: string | undefined
  state: AgentStatusState
}

export type AgentTurnWorkspaceStatusDeps = {
  isEnabled: () => boolean
  getWorkspaceStatuses: () => readonly WorkspaceStatusDefinition[]
  /** Authoritative tab→worktree resolution from the session's tab map. */
  resolveWorktreeIdForTab: (tabId: string) => string | undefined
  /** Column the board shows for the workspace, with the same default a missing status resolves to. */
  getWorkspaceStatus: (worktreeId: string) => WorkspaceStatus
  getLivePanes: () => readonly AgentTurnWorkspaceStatusPane[]
  setWorkspaceStatus: (worktreeId: string, status: WorkspaceStatus) => Promise<void>
}

const OPEN_TURN_STATES: readonly AgentStatusState[] = ['working', 'blocked', 'waiting']

// Why: `unconfirmed` is an end the host cannot prove and is never success, so it is no more
// evidence of finished work than a stop the person asked for. Absent means unknown and still
// moves the card, because a provider that reports no verdict is the common case.
const NON_HANDOFF_OUTCOMES: readonly AgentTurnOutcome[] = [
  'cancellation',
  'interruption',
  'unconfirmed',
  'superseded'
]

const lastTurnStateByPaneKey = new Map<string, AgentStatusState>()
const TRACKED_PANE_LIMIT = 500

/** Test seam: clear the per-process turn tracking. */
export function resetAgentTurnWorkspaceStatusState(): void {
  lastTurnStateByPaneKey.clear()
}

function rememberTurnState(paneKey: string, state: AgentStatusState): void {
  lastTurnStateByPaneKey.delete(paneKey)
  lastTurnStateByPaneKey.set(paneKey, state)
  while (lastTurnStateByPaneKey.size > TRACKED_PANE_LIMIT) {
    const oldest = lastTurnStateByPaneKey.keys().next().value
    if (oldest === undefined) {
      return
    }
    lastTurnStateByPaneKey.delete(oldest)
  }
}

function isOpenTurnState(state: AgentStatusState): boolean {
  return OPEN_TURN_STATES.includes(state)
}

export async function maybeSyncWorkspaceStatusOnAgentTurn(
  event: AgentTurnWorkspaceStatusEvent,
  deps: AgentTurnWorkspaceStatusDeps
): Promise<void> {
  // Cheap gates first: only fresh activity is evidence of a turn boundary.
  if (event.isReplay || event.restoredUnconfirmed || event.providerSessionOnly) {
    return
  }
  const turnState = event.leadState ?? event.rowState
  const previousState = lastTurnStateByPaneKey.get(event.paneKey)
  rememberTurnState(event.paneKey, turnState)
  // Why both edges need a real transition: a session opened at an idle prompt reports `done`
  // before anyone has typed, and that alone is not a finished turn. A `sessionBoundary` row says
  // the same thing explicitly, on the builds that stamp it.
  const turnEnded =
    turnState === 'done' &&
    event.sessionBoundary !== true &&
    previousState !== undefined &&
    isOpenTurnState(previousState)
  const turnOpened =
    isOpenTurnState(turnState) && (previousState === undefined || previousState === 'done')
  if (!turnEnded && !turnOpened) {
    return
  }
  // Why after the edge: reading UI state normalizes it, and this fires on every hook event.
  if (!deps.isEnabled()) {
    return
  }
  const worktreeId =
    (event.tabId ? deps.resolveWorktreeIdForTab(event.tabId) : undefined) ?? event.worktreeId
  if (!worktreeId) {
    return
  }
  try {
    await (turnEnded ? moveToReview(event, worktreeId, deps) : moveToProgress(worktreeId, deps))
  } catch (error) {
    // Why: board convenience must never disrupt the agent whose turn just ended.
    console.warn('[workspace-status-turn-sync] move failed:', error)
  }
}

async function moveToReview(
  event: AgentTurnWorkspaceStatusEvent,
  worktreeId: string,
  deps: AgentTurnWorkspaceStatusDeps
): Promise<void> {
  if (event.leadOutcome && NON_HANDOFF_OUTCOMES.includes(event.leadOutcome)) {
    return
  }
  // Why: a second pane still running means the workspace is not waiting on anyone, and the
  // other pane's own boundary will move the card when its turn closes.
  const otherPaneWorking = deps
    .getLivePanes()
    .some(
      (pane) =>
        pane.paneKey !== event.paneKey &&
        pane.worktreeId === worktreeId &&
        isOpenTurnState(pane.state)
    )
  if (otherPaneWorking) {
    return
  }
  await moveCard(worktreeId, [DEFAULT_WORKSPACE_STATUS_ID], WORKSPACE_STATUS_IN_REVIEW_ID, deps)
}

async function moveToProgress(
  worktreeId: string,
  deps: AgentTurnWorkspaceStatusDeps
): Promise<void> {
  await moveCard(
    worktreeId,
    [WORKSPACE_STATUS_IN_REVIEW_ID, WORKSPACE_STATUS_TODO_ID],
    DEFAULT_WORKSPACE_STATUS_ID,
    deps
  )
}

/** Moves the card only between columns this behaviour owns, so a column the person chose by
 *  hand — Done above all — is never dragged. */
async function moveCard(
  worktreeId: string,
  fromStatuses: readonly WorkspaceStatus[],
  toStatus: WorkspaceStatus,
  deps: AgentTurnWorkspaceStatusDeps
): Promise<void> {
  const statuses = deps.getWorkspaceStatuses()
  if (!isWorkspaceStatusId(toStatus, statuses)) {
    return
  }
  const current = deps.getWorkspaceStatus(worktreeId)
  if (current === toStatus || !fromStatuses.some((status) => status === current)) {
    return
  }
  await deps.setWorkspaceStatus(worktreeId, toStatus)
}
