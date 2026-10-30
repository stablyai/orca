import { translate } from '../i18n/mobile-i18n'
import type { MobileHostedReviewEligibilityReply } from './hosted-review-reply-schema'
import { supportsHostedReviewCreation } from '../../../src/shared/hosted-review-creation-providers'
import { resolveCreateReviewIntentEligibility } from '../../../src/shared/source-control-create-review-intent'
import { hostedReviewCopy } from './hosted-review-copy'
import { getMobilePrCreateBlockMessage } from './mobile-pr-create'

export type MobileCreatePrEligibilityState =
  | { kind: 'idle' }
  | { kind: 'loading'; eligibility: MobileHostedReviewEligibilityReply | null }
  | { kind: 'ready'; eligibility: MobileHostedReviewEligibilityReply }
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

export type MobileCreatePrPrepareInputs = Omit<
  Parameters<typeof resolveCreateReviewIntentEligibility>[0],
  'hostedReviewCreation'
>

export type BuildMobileCreatePrActionArgs = {
  branch: string | null | undefined
  eligibilityState: MobileCreatePrEligibilityState
  busyAction: string | null
  // What desktop's intent rule needs to know the branch can be prepared (commit, publish, sync).
  prepareInputs?: MobileCreatePrPrepareInputs
  onCreatePr: (pushFirst: boolean) => void
}

const BUSY_ACTIONS = new Set(['create-pr', 'push-create-pr'])

function hiddenAction(onPress: () => void): MobileCreatePrAction {
  return {
    visible: false,
    label: translate('sourceControl.createPrAction.createPullRequest', 'Create Pull Request'),
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
  prepareInputs,
  onCreatePr
}: BuildMobileCreatePrActionArgs): MobileCreatePrAction {
  const noop = () => {}
  if (!branch || eligibilityState.kind === 'idle') {
    return hiddenAction(noop)
  }
  if (eligibilityState.kind === 'error') {
    return {
      visible: true,
      label: translate(
        'sourceControl.createPrAction.statusUnavailable',
        'Review status unavailable'
      ),
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
      label: translate('sourceControl.createPrAction.checkingStatus', 'Checking review status…'),
      disabled: true,
      loading: true,
      pushFirst: false,
      onPress: noop
    }
  }
  // Mirror the desktop provider gate; do not depend on hosts supplying hidden blocked reasons.
  if (!supportsHostedReviewCreation(eligibility.provider)) {
    return {
      visible: true,
      label: translate(
        'sourceControl.createPrAction.providerUnavailable',
        'Review creation unavailable for this provider'
      ),
      disabled: true,
      loading: false,
      pushFirst: false,
      onPress: noop
    }
  }
  const copy = hostedReviewCopy(eligibility.provider)
  const label = translate('sourceControl.createPrAction.createReview', 'Create {{titleLabel}}', {
    titleLabel: copy.titleLabel
  })
  // Busy workflows no-op; disable the action rather than expose an inert button.
  const busy = busyAction !== null
  const loading = busyAction !== null && BUSY_ACTIONS.has(busyAction)
  // Retain stale chrome during reload, but never create from its outdated eligibility.
  const stale = eligibilityState.kind === 'loading'
  const pushFirst = eligibility.blockedReason === 'needs_push'

  // Desktop's intent rule: a branch Create PR can commit, publish or sync is enterable; the gate rechecks before create.
  const preparable =
    prepareInputs !== undefined &&
    resolveCreateReviewIntentEligibility({ ...prepareInputs, hostedReviewCreation: eligibility })
      .eligible
  if (eligibility.canCreate || pushFirst || preparable) {
    const disabled = busy || stale
    return {
      visible: true,
      label,
      disabled,
      loading,
      pushFirst,
      // Disabled descriptors must have no live handler that can act against stale state.
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
      nextAction: eligibility.nextAction,
      reviewLookupOutcome: eligibility.reviewLookupOutcome
    }) ??
    translate(
      'sourceControl.prCreate.notReady',
      'This branch is not ready for a {{reviewLabel}} yet.',
      { reviewLabel: copy.reviewLabel }
    )

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
