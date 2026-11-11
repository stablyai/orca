import { recordRendererCrashBreadcrumb } from '@/diagnostics/crash-reporting/crash-breadcrumb-recorder'

/** Why a finished agent turn did not mark its workspace unread. */
export type AgentFinishDropCause =
  | 'fresh-active-hook-status'
  | 'superseded-snapshot'
  | 'muted-workspace'
  | 'coordinator-only-news'
  | 'no-live-session'
  | 'unknown-surface'
  | 'superseded-surface'
  | 'viewed'
  | 'pane-pruned-before-quiet-window'
  | 'held-revision-expired'
  | 'pane-not-live'
  | 'hook-lane-disabled'
  | 'turn-end-not-counted'
  | 'restored-unconfirmed'
  | 'host-replay-skipped'

/** Every path that drops a finish was silent, so a missing unread could not be traced (#40340). */
export function recordAgentFinishDropped(
  cause: AgentFinishDropCause,
  subject: { workspaceId?: string; paneKey?: string | null }
): void {
  recordRendererCrashBreadcrumb('agent_finish_dropped', {
    cause,
    ...(subject.workspaceId ? { workspaceId: subject.workspaceId } : {}),
    ...(subject.paneKey ? { paneKey: subject.paneKey } : {})
  })
}

/** A finish waiting out its quiet window is lost when its pane's coordinator is pruned. */
export function recordPrunedPendingFinish(
  workspaceId: string,
  paneKey: string,
  coordinator: { hasPendingHookDoneCompletion: () => boolean }
): void {
  if (coordinator.hasPendingHookDoneCompletion()) {
    recordAgentFinishDropped('pane-pruned-before-quiet-window', { workspaceId, paneKey })
  }
}

/** The hook lane ignores updates for a pane it does not consider live; only a finish matters here. */
export function recordFinishOnPaneNotLive(
  workspaceId: string,
  paneKey: string,
  state: string
): void {
  if (state === 'done') {
    recordAgentFinishDropped('pane-not-live', { workspaceId, paneKey })
  }
}

/** Completion notifications are off for this pane (setting, or waiting for a fresh working state). */
export function recordHookLaneDisabled(workspaceId: string, paneKey: string): void {
  recordAgentFinishDropped('hook-lane-disabled', { workspaceId, paneKey })
}
