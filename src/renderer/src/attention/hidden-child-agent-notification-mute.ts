import type { AppState } from '@/store/types'
import { getRepoMapFromState, getWorktreeMapFromState } from '@/store/selectors'
import { buildActivityEvents } from '@/components/activity/activity-event-builder'
import { buildAgentPaneThreads } from '@/components/activity/activity-thread-builder'
import { collectChildAgentPaneKeys } from '@/components/activity/activity-thread-child-agent'

export function isChildAgentNotificationMuted(state: AppState, paneKey: string): boolean {
  if (state.agentsShowChildAgents !== false) {
    return false
  }
  if (
    !state.agentStatusByPaneKey[paneKey]?.orchestration &&
    !state.retainedAgentsByPaneKey[paneKey]?.entry.orchestration &&
    !state.runtimeAgentOrchestrationByPaneKey[paneKey]
  ) {
    return false
  }

  // Use Activity's sources and lineage rules so retained parents, orphans and cycles agree.
  const activity = buildActivityEvents({
    agentStatusByPaneKey: state.agentStatusByPaneKey,
    runtimeAgentOrchestrationByPaneKey: state.runtimeAgentOrchestrationByPaneKey,
    migrationUnsupportedByPtyId: state.migrationUnsupportedByPtyId,
    retainedAgentsByPaneKey: state.retainedAgentsByPaneKey,
    tabsByWorktree: state.tabsByWorktree,
    unifiedTabsByWorktree: state.unifiedTabsByWorktree,
    worktreeMap: getWorktreeMapFromState(state),
    repoMap: getRepoMapFromState(state),
    repos: state.repos,
    resolveWorktree: state.getKnownWorktreeById,
    acknowledgedAgentsByPaneKey: state.acknowledgedAgentsByPaneKey,
    activityClearedAtByPaneKey: state.activityClearedAtByPaneKey,
    now: Date.now()
  })
  return collectChildAgentPaneKeys(buildAgentPaneThreads(activity)).has(paneKey)
}
