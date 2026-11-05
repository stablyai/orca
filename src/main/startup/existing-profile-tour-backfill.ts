import type { Store } from '../persistence/loading-store/store'

// v1.4.249 publish time: it prepended a "+" step that no existing action completes, restarting this tour for long-time users.
const AGENT_SESSIONS_TOUR_REPLAYED_AFTER = Date.UTC(2026, 10, 4, 23, 53, 56)

type TourBackfillStore = Pick<Store, 'getOnboarding' | 'getUI' | 'updateUI'>

export function backfillAgentSessionsTourForExistingProfiles(store: TourBackfillStore): void {
  const { closedAt } = store.getOnboarding()
  if (closedAt === null || closedAt >= AGENT_SESSIONS_TOUR_REPLAYED_AFTER) {
    return
  }
  const seenIds = store.getUI().contextualToursSeenIds ?? []
  if (seenIds.includes('workspace-agent-sessions')) {
    return
  }
  store.updateUI({ contextualToursSeenIds: [...seenIds, 'workspace-agent-sessions'] })
}
