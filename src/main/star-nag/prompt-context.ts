import { STAR_NAG_INITIAL_THRESHOLD } from '../../shared/constants'
import {
  bucketStarNagAgentsSinceBaseline,
  type StarNagPromptMode,
  type StarNagPromptSource
} from '../../shared/star-nag-telemetry'
import type { Store } from '../persistence'
import type { StatsCollector } from '../stats/collector'
import { getCohortAtEmit } from '../telemetry/cohort-classifier'
import type { StarNagPromptContext } from './prompt-session-telemetry'

export function createStarNagPromptContext(
  store: Store,
  stats: StatsCollector,
  source: StarNagPromptSource,
  mode: StarNagPromptMode
): StarNagPromptContext {
  const ui = store.getUI()
  const threshold = ui.starNagNextThreshold ?? STAR_NAG_INITIAL_THRESHOLD
  const agentsSinceBaseline = Math.max(
    0,
    stats.getTotalAgentsSpawned() - (ui.starNagBaselineAgents ?? 0)
  )
  return {
    source,
    mode,
    threshold,
    agents_since_baseline: agentsSinceBaseline,
    agents_since_baseline_bucket: bucketStarNagAgentsSinceBaseline(agentsSinceBaseline),
    ...getCohortAtEmit()
  }
}
