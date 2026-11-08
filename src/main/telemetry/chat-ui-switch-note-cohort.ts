import { randomInt } from 'node:crypto'
import type { Store } from '../persistence/loading-store/store'
import { resolveConsent } from './consent'

export function ensureChatUiSwitchNoteCohort(store: Store): 'control' | 'treatment' | undefined {
  try {
    const settings = store.getSettings()
    const telemetry = settings.telemetry
    const saved = telemetry?.chatUiSwitchNoteCohort
    if (saved === 'control' || saved === 'treatment') {
      return saved
    }
    if (
      !telemetry ||
      resolveConsent(settings).effective !== 'enabled' ||
      settings.agentDefaultSurface === 'chat' ||
      store.getChatUiLaunchTipVariant() !== 'chat-ui-off' ||
      store.getUI().featureTipsSeenIds?.includes('chat-ui-here')
    ) {
      return undefined
    }
    const cohort = randomInt(2) === 0 ? 'control' : 'treatment'
    store.updateSettings({ telemetry: { ...telemetry, chatUiSwitchNoteCohort: cohort } })
    return cohort
  } catch (err) {
    console.warn('[telemetry] chat UI switch note cohort assignment failed', err)
    return undefined
  }
}
