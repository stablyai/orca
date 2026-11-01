import type { CommonProps } from '../../shared/telemetry-events'
import type { Store } from '../persistence/loading-store/store'
import {
  ensureChatUiLaunchTipCohort,
  type ChatUiLaunchTipEligibility
} from './chat-ui-launch-tip-cohort'

export type { ChatUiLaunchTipEligibility } from './chat-ui-launch-tip-cohort'

export function experimentCohortProps(
  store: Store,
  resolveChatUiEligibility: ChatUiLaunchTipEligibility
): Pick<
  CommonProps,
  'onboarding_language_v1' | 'chat_ui_launch_tip_v1' | 'chat_ui_launch_tip_targeting_v1'
> {
  const cohort = ensureChatUiLaunchTipCohort(store, resolveChatUiEligibility)
  const telemetry = store.getSettings().telemetry
  const language = telemetry?.onboardingLanguageCohort
  const targeting =
    cohort === 'treatment' || cohort === 'treatment-live-switch'
      ? telemetry?.chatUiLaunchTipTargeting?.mode
      : undefined
  return {
    onboarding_language_v1:
      language === 'control' || language === 'treatment' ? language : undefined,
    chat_ui_launch_tip_v1: cohort,
    chat_ui_launch_tip_targeting_v1:
      targeting === 'all' || targeting === 'eligible-harnesses' ? targeting : undefined
  }
}
