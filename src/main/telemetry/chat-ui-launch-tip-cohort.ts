import type { Store } from '../persistence/loading-store/store'
import { resolveConsent } from './consent'
import { getFeatureTipSeenId } from '../../shared/feature-tips'
import type { ChatUiLaunchTipCohort } from '../../shared/telemetry-settings-types'

export type { ChatUiLaunchTipCohort }

// Decided once per launch, so the tip and its telemetry read the same consent; contributor builds never set it.
let deferredForConsent = false

/**
 * Only reads back a saved assignment; nothing new is assigned. While the telemetry banner is
 * unresolved for a profile still due the tip, the tip waits.
 */
export function ensureChatUiLaunchTipCohort(store: Store): ChatUiLaunchTipCohort | undefined {
  deferredForConsent = false
  try {
    const settings = store.getSettings()
    const telemetry = settings.telemetry
    const saved = telemetry?.chatUiLaunchTipRolloutCohort ?? telemetry?.chatUiLaunchTipCohort
    if (
      telemetry &&
      store.getChatUiLaunchTipVariant() !== 'none' &&
      // Why: some profiles carry the generic id without having seen the tip; check the id that applies.
      !store.getUI().featureTipsSeenIds?.includes(getFeatureTipSeenId('chat-ui-here', telemetry))
    ) {
      deferredForConsent = resolveConsent(settings).effective === 'pending_banner'
    }
    return saved
  } catch (err) {
    // Startup must not fail over this read; the tip still follows the saved settings.
    console.warn('[telemetry] chat UI launch tip settings read failed', err)
    return undefined
  }
}

/** True when this launch holds the tip back until the telemetry banner is resolved. */
export function isChatUiLaunchTipDeferredForConsent(): boolean {
  return deferredForConsent
}
