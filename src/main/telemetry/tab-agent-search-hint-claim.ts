import { randomInt } from 'node:crypto'
import type { Store } from '../persistence/loading-store/store'
import { resolveConsent } from './consent'
import { track } from './client'

export function claimTabAgentSearchHint(
  store: Store,
  previouslyExposed: boolean
): 'control' | 'treatment' | null {
  const settings = store.getSettings()
  const telemetry = settings.telemetry
  if (!telemetry || telemetry.tabAgentSearchHintExposed) {
    return null
  }
  if (previouslyExposed) {
    store.updateSettings({ telemetry: { ...telemetry, tabAgentSearchHintExposed: true } })
    return null
  }
  if (resolveConsent(settings).effective !== 'enabled') {
    return null
  }
  const assignment =
    telemetry.tabAgentSearchHintCohort ?? (randomInt(2) === 0 ? 'control' : 'treatment')
  store.updateSettings({
    telemetry: {
      ...telemetry,
      tabAgentSearchHintCohort: assignment,
      tabAgentSearchHintExposed: true
    }
  })
  try {
    store.flushOrThrow()
    if (track('tab_agent_search_hint_exposure', {})) {
      return assignment
    }
  } catch (error) {
    store.updateSettings({
      telemetry: { ...store.getSettings().telemetry!, tabAgentSearchHintExposed: false }
    })
    throw error
  }
  store.updateSettings({
    telemetry: { ...store.getSettings().telemetry!, tabAgentSearchHintExposed: false }
  })
  store.flushOrThrow()
  return null
}
