import type { CommonProps } from '../../shared/telemetry-events'
import type { Store } from '../persistence/loading-store/store'
import { ensureChatUiLaunchTipCohort } from './chat-ui-launch-tip-cohort'

export function experimentCohortProps(
  store: Store
): Pick<
  CommonProps,
  | 'onboarding_language_v1'
  | 'chat_ui_launch_tip_v1'
  | 'chat_ui_launch_tip_targeting_v1'
  | 'chat_ui_launch_tip_button_emphasis_v1'
> {
  const cohort = ensureChatUiLaunchTipCohort(store)
  const telemetry = store.getSettings().telemetry
  const language = telemetry?.onboardingLanguageCohort
  const buttonEmphasis = telemetry?.chatUiLaunchTipButtonEmphasis
  const targeting =
    cohort === 'treatment' ||
    cohort === 'treatment-live-switch' ||
    cohort === 'treatment-swapped-buttons' ||
    cohort === 'treatment-center'
      ? telemetry?.chatUiLaunchTipTargeting?.mode
      : undefined
  return {
    onboarding_language_v1:
      language === 'control' || language === 'treatment' ? language : undefined,
    chat_ui_launch_tip_v1: cohort,
    chat_ui_launch_tip_button_emphasis_v1:
      buttonEmphasis === 'normal' || buttonEmphasis === 'swapped' ? buttonEmphasis : undefined,
    chat_ui_launch_tip_targeting_v1:
      targeting === 'all' || targeting === 'eligible-harnesses' || targeting === 'not-switched'
        ? targeting
        : undefined
  }
}
