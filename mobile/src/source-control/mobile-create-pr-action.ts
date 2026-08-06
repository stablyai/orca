import type { HostedReviewCreationEligibility } from '../../../src/shared/hosted-review'
import { supportsHostedReviewCreation } from '../../../src/shared/hosted-review-creation-providers'
import { hostedReviewCopy } from './hosted-review-copy'
import { getMobilePrCreateBlockMessage } from './mobile-pr-create'
import { t } from '@/i18n/mobile-i18n'

export type MobileCreatePrEligibilityState =
  | { kind: 'idle' }
  | { kind: 'loading'; eligibility: HostedReviewCreationEligibility | null }
  | { kind: 'ready'; eligibility: HostedReviewCreationEligibility }
  | { kind: 'error' }

export type MobileCreatePrAction = {
  visible: boolean
  label: string
  disabled: boolean
  hint?: string
  loading: boolean
  pushFirst: boolean
  onPress: () => void
}

export type BuildMobileCreatePrActionArgs = {
  branch: string | null | undefined
  eligibilityState: MobileCreatePrEligibilityState
  busyAction: string | null
  onCreatePr: (pushFirst: boolean) => void
}

const BUSY_ACTIONS = new Set(['create-pr', 'push-create-pr'])

function hiddenAction(onPress: () => void): MobileCreatePrAction {
  return {
    visible: false,
    label: t('mobileCreatePrAction.createPull'),
    disabled: true,
    loading: false,
    pushFirst: false,
    onPress
  }
}

export function buildMobileCreatePrAction({
  branch,
  eligibilityState,
  busyAction,
  onCreatePr
}: BuildMobileCreatePrActionArgs): MobileCreatePrAction {
  const noop = () => {}
  if (!branch || eligibilityState.kind === 'idle') {
    return hiddenAction(noop)
  }
  if (eligibilityState.kind === 'error') {
    return {
      visible: true,
      label: t('sourceControl.reviewStatus.unavailable'),
      disabled: true,
      loading: false,
      pushFirst: false,
      onPress: noop
    }
  }
  const eligibility = eligibilityState.eligibility
  if (!eligibility) {
    return {
      visible: true,
      label: t('sourceControl.reviewStatus.checking'),
      disabled: true,
      loading: true,
      pushFirst: false,
      onPress: noop
    }
  }
  // Why: mirror desktop's structural provider gate (supportsHostedReviewCreation)
  // instead of relying on the host always emitting a hidden blockedReason for
  // non-creatable providers like bitbucket.
  if (!supportsHostedReviewCreation(eligibility.provider)) {
    return {
      visible: true,
      label: t('sourceControl.reviewStatus.unsupportedProvider'),
      disabled: true,
      loading: false,
      pushFirst: false,
      onPress: noop
    }
  }
  const copy = hostedReviewCopy(eligibility.provider)
  const label = t('mobileCreatePrAction.createReview', {
    reviewType: copy.titleLabel
  })
  // Any in-flight git work blocks the action: runGitWorkflow no-ops while
  // busyActionRef is set, so an enabled-looking button would silently do nothing.
  const busy = busyAction !== null
  const loading = busyAction !== null && BUSY_ACTIONS.has(busyAction)
  // Why: while a newer eligibility request is loading we keep the prior ready
  // snapshot for stable chrome, but must not act on it — treat stale-loading as
  // disabled so a tap cannot fire against an out-of-date canCreate/pushFirst.
  const stale = eligibilityState.kind === 'loading'
  const pushFirst = eligibility.blockedReason === 'needs_push'

  if (eligibility.canCreate || pushFirst) {
    const disabled = busy || stale
    return {
      visible: true,
      label,
      disabled,
      loading,
      pushFirst,
      // Why: never hand a disabled descriptor a live handler — a tap must be a
      // true no-op when busy/stale, not a deferred create against stale state.
      onPress: disabled ? noop : () => onCreatePr(pushFirst)
    }
  }

  const hint =
    getMobilePrCreateBlockMessage({
      provider: eligibility.provider,
      base: eligibility.defaultBaseRef || 'main',
      title: eligibility.title || branch,
      body: eligibility.body || '',
      canCreate: false,
      blockedReason: eligibility.blockedReason,
      nextAction: eligibility.nextAction
    }) ??
    t('mobileCreatePrAction.branch', {
      reviewType: copy.reviewLabel
    })

  return {
    visible: true,
    label,
    disabled: true,
    hint,
    loading,
    pushFirst: false,
    onPress: noop
  }
}
