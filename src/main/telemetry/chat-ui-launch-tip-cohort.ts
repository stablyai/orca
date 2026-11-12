import { randomInt } from 'node:crypto'
import type { Store } from '../persistence/loading-store/store'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { resolveConsent } from './consent'
import type {
  ChatUiLaunchTipCohort,
  ChatUiLaunchTipTargeting
} from '../../shared/telemetry-settings-types'

export type { ChatUiLaunchTipCohort }

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
    const rollout = telemetry?.chatUiLaunchTipRolloutCohort
    if (rollout === 'control' || rollout === 'treatment') {
      return rollout
    }
    if (
      saved === 'treatment' ||
      saved === 'treatment-live-switch' ||
      saved === 'treatment-swapped-buttons' ||
      saved === 'treatment-center'
    ) {
      return saved
    }
    if (
      !telemetry ||
      store.getChatUiLaunchTipVariant() === 'none' ||
      (saved !== 'control' && store.getUI().featureTipsSeenIds?.includes('chat-ui-here'))
    ) {
      return saved === 'control' ? saved : undefined
    }
    const consent = resolveConsent(settings).effective
    if (consent !== 'enabled') {
      deferredForConsent = consent === 'pending_banner'
      return saved === 'control' ? saved : undefined
    }
    // Promote 3/7 of the old 70% control group once: 30% + 70% × 3/7 = 60% treatment.
    const draw = randomInt(saved === 'control' ? 7 : 10)
    const cohort: ChatUiLaunchTipCohort = draw < 4 ? 'control' : 'treatment'
    const targeting =
      cohort === 'control' ? undefined : assignTargeting(settings.agentDefaultSurface)
    store.updateSettings({
      telemetry: {
        ...telemetry,
        chatUiLaunchTipRolloutCohort: cohort,
        ...(targeting
          ? {
              chatUiLaunchTipTargeting: targeting,
              chatUiLaunchTipButtonEmphasis: randomInt(2) === 0 ? 'normal' : 'swapped'
            }
          : {})
      }
    })
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

function assignTargeting(
  defaultSurface: GlobalSettings['agentDefaultSurface']
): ChatUiLaunchTipTargeting {
  if (randomInt(2) === 0) {
    return { mode: 'all' }
  }
  return { mode: 'not-switched', eligible: defaultSurface !== 'chat' }
}
