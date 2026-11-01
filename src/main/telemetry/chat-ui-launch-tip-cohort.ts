import { randomInt } from 'node:crypto'
import type { Store } from '../persistence'
import { resolveConsent } from './consent'

export type ChatUiLaunchTipCohort = 'control' | 'treatment'

// Decided once per launch with the cohort, so the tip and its enrollment read the same consent; contributor builds never set it.
let deferredForConsent = false

/**
 * Enrolls once, only profiles still due the tip whose events can be measured. While the telemetry
 * banner is unresolved the tip waits, so the exposure is never spent unmeasured; opted-out and
 * contributor builds stay unenrolled and see the tip as before.
 */
export function ensureChatUiLaunchTipCohort(store: Store): ChatUiLaunchTipCohort | undefined {
  deferredForConsent = false
  try {
    const settings = store.getSettings()
    const telemetry = settings.telemetry
    const saved = telemetry?.chatUiLaunchTipCohort
    if (saved === 'control' || saved === 'treatment') {
      return saved
    }
    if (
      !telemetry ||
      store.getChatUiLaunchTipVariant() === 'none' ||
      store.getUI().featureTipsSeenIds?.includes('chat-ui-here')
    ) {
      return undefined
    }
    const consent = resolveConsent(settings).effective
    if (consent !== 'enabled') {
      deferredForConsent = consent === 'pending_banner'
      return undefined
    }
    const cohort: ChatUiLaunchTipCohort = randomInt(2) === 0 ? 'control' : 'treatment'
    store.updateSettings({ telemetry: { ...telemetry, chatUiLaunchTipCohort: cohort } })
    return cohort
  } catch (err) {
    // Startup must not fail over an experiment; unenrolled profiles see the tip as before.
    console.warn('[telemetry] chat UI launch tip cohort assignment failed', err)
    return undefined
  }
}

/** True when this launch holds the tip back until the telemetry banner is resolved. */
export function isChatUiLaunchTipDeferredForConsent(): boolean {
  return deferredForConsent
}
