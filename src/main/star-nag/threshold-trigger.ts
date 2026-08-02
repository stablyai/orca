import { app } from 'electron'
import { STAR_NAG_INITIAL_THRESHOLD } from '../../shared/constants'
import type { Store } from '../persistence'
import type { StatsCollector } from '../stats/collector'

type ThresholdPromptInput = {
  store: Store
  stats: StatsCollector
  total: number
  promptVisible: boolean
  evaluating: boolean
  isCooldownActive: (deferredUntil: number | null | undefined) => boolean
}

export function ensureStarNagBaseline(store: Store, stats: StatsCollector): void {
  const ui = store.getUI()
  const currentVersion = app.getVersion()
  if (ui.starNagAppVersion === currentVersion && ui.starNagBaselineAgents != null) {
    return
  }
  // Why: after an update, completed users stay suppressed but everyone else
  // gets a fresh countdown from the current agent total.
  store.updateUI({
    starNagAppVersion: currentVersion,
    starNagBaselineAgents: stats.getTotalAgentsSpawned(),
    starNagNextThreshold: STAR_NAG_INITIAL_THRESHOLD
  })
}

export function shouldShowStarNagThresholdPrompt(input: ThresholdPromptInput): boolean {
  if (input.promptVisible || input.evaluating) {
    return false
  }
  const ui = input.store.getUI()
  if (ui.starNagCompleted || input.isCooldownActive(ui.starNagDeferredUntil)) {
    return false
  }
  if (ui.starNagAppVersion !== app.getVersion()) {
    ensureStarNagBaseline(input.store, input.stats)
    return false
  }
  const baseline = ui.starNagBaselineAgents ?? input.total
  const threshold = ui.starNagNextThreshold ?? STAR_NAG_INITIAL_THRESHOLD
  return input.total - baseline >= threshold
}
