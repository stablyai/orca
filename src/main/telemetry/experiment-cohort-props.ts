import type { CommonProps } from '../../shared/telemetry-events'
import type { Store } from '../persistence/loading-store/store'
import type { TelemetrySettings } from '../../shared/telemetry-settings-types'
import { ensureChatUiLaunchTipCohort } from './chat-ui-launch-tip-cohort'

export function experimentCohortProps(
  store: Store
): Pick<
  CommonProps,
  | 'first_launch_layout_v1'
  | 'onboarding_language_v1'
  | 'chat_ui_launch_tip_v1'
  | 'chat_ui_launch_tip_rollout_v1'
  | 'chat_ui_launch_tip_targeting_v1'
  | 'chat_ui_launch_tip_button_emphasis_v1'
> {
  const cohort = ensureChatUiLaunchTipCohort(store)
  const telemetry = store.getSettings().telemetry
  // Preserve the original cohort to distinguish old controls from new enrollees in expansion analysis.
  const historical = telemetry?.chatUiLaunchTipCohort
  const rollout = telemetry?.chatUiLaunchTipRolloutCohort
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
    first_launch_layout_v1: firstLaunchLayoutProp(telemetry),
    onboarding_language_v1:
      language === 'control' || language === 'treatment' ? language : undefined,
    chat_ui_launch_tip_v1:
      historical === 'control' ||
      historical === 'treatment' ||
      historical === 'treatment-live-switch' ||
      historical === 'treatment-swapped-buttons' ||
      historical === 'treatment-center'
        ? historical
        : undefined,
    chat_ui_launch_tip_rollout_v1:
      rollout === 'control' || rollout === 'treatment' ? rollout : undefined,
    chat_ui_launch_tip_button_emphasis_v1:
      buttonEmphasis === 'normal' || buttonEmphasis === 'swapped' ? buttonEmphasis : undefined,
    chat_ui_launch_tip_targeting_v1:
      targeting === 'all' || targeting === 'eligible-harnesses' || targeting === 'not-switched'
        ? targeting
        : undefined
  }
}

/** Profiles not reported on their first launch stay unlabelled, so their later events never carry the layout. */
export function firstLaunchLayoutProp(
  telemetry: TelemetrySettings | undefined
): CommonProps['first_launch_layout_v1'] {
  const layout = telemetry?.firstLaunchLayout
  return telemetry?.firstLaunchLayoutReport !== 'skipped' &&
    (layout === 'home-workspace' || layout === 'project-picker')
    ? layout
    : undefined
}
