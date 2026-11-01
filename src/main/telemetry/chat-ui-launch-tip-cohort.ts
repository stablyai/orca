import { randomInt } from 'node:crypto'
import type { Store } from '../persistence'
import { resolveConsent } from './consent'

export type ChatUiLaunchTipCohort = 'control' | 'treatment'

/** Enrolls once, only profiles still due the tip whose events can be measured; everyone else keeps seeing it. */
export function ensureChatUiLaunchTipCohort(store: Store): ChatUiLaunchTipCohort | undefined {
  try {
    const telemetry = store.getSettings().telemetry
    const saved = telemetry?.chatUiLaunchTipCohort
    if (saved === 'control' || saved === 'treatment') {
      return saved
    }
    if (
      !telemetry ||
      resolveConsent(store.getSettings()).effective === 'disabled' ||
      store.getChatUiLaunchTipVariant() === 'none' ||
      store.getUI().featureTipsSeenIds?.includes('chat-ui-here')
    ) {
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
