import { STAR_NAG_INITIAL_THRESHOLD } from '../../shared/constants'
import type { Store } from '../persistence'
import type { StatsCollector } from '../stats/collector'

export function deferAfterStarNagWebHandoff(
  store: Store,
  stats: StatsCollector,
  cooldownMs: number
): void {
  const ui = store.getUI()
  const threshold = ui.starNagNextThreshold ?? STAR_NAG_INITIAL_THRESHOLD
  store.updateUI({
    starNagNextThreshold: threshold * 2,
    starNagBaselineAgents: stats.getTotalAgentsSpawned(),
    starNagDeferredUntil: Date.now() + cooldownMs
  })
}
