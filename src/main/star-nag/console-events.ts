import { app } from 'electron'
import { STAR_NAG_INITIAL_THRESHOLD } from '../../shared/constants'
import type { StarNagPromptSource } from '../../shared/star-nag-telemetry'
import type { Store } from '../persistence'
import type { StatsCollector } from '../stats/collector'

type StarNagConsoleEvent = 'star_nag_shown' | 'star_nag_dismissed' | 'star_nag_later'

export function logStarNagConsoleEvent(
  store: Store,
  stats: StatsCollector,
  event: StarNagConsoleEvent,
  source: StarNagPromptSource,
  nextThreshold?: number
): void {
  const ui = store.getUI()
  const threshold = ui.starNagNextThreshold ?? STAR_NAG_INITIAL_THRESHOLD
  const agentsSinceBaseline = Math.max(
    0,
    stats.getTotalAgentsSpawned() - (ui.starNagBaselineAgents ?? 0)
  )

  console.info({
    event,
    app_version: app.getVersion(),
    threshold,
    agents_since_baseline: agentsSinceBaseline,
    source,
    ...(nextThreshold === undefined ? {} : { next_threshold: nextThreshold })
  })
}
