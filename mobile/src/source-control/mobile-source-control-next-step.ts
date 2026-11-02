import { translate } from '../i18n/mobile-i18n'
import type { PRInfo } from '../../../src/shared/github/pull-request-types'
import { resolveGitHubPRMergeMethods } from '../../../src/shared/github/pull-request-merge-methods'
import { getGitHubPRPrimaryReviewer } from '../../../src/shared/github/pr-reviewer-display'
import type { GitHubWorkItemDetails } from '../../../src/shared/github/work-item-types'
import type { SourceControlNextStep } from '../../../src/shared/source-control-next-step-decision'
import { presentPrMerge } from '../components/pr-sidebar/pr-actions-state'
import type { MobileCreatePrAction } from './mobile-create-pr-action'
import type { MobileSourceControlPrimaryAction } from './mobile-source-control-primary-action'

// String keys keep native lucide imports out of this module.
export type MobileNextStepIcon =
  | 'push'
  | 'pull'
  | 'sync'
  | 'review'
  | 'agent'
  | 'merge'
  | 'complete'

export type MobileNextStepTone = 'primary' | 'secondary' | 'merge'

export type MobileNextStepReason = { lead?: string; text: string }

export type MobileNextStepBarView =
  | { kind: 'hidden' }
  | { kind: 'composer' }
  | {
      kind: 'button'
      label: string
      icon: MobileNextStepIcon
      tone: MobileNextStepTone
      disabled: boolean
      loading: boolean
      reason: MobileNextStepReason | null
      accessibilityHint?: string
      onPress: () => void
    }
  | { kind: 'auto_merge_on'; loading: boolean; disabled: boolean; onCancel: () => void }
  | { kind: 'merged'; baseRef: string | null }

export type MobileNextStepHandlers = {
  completeMerge: () => void
  resolveConflicts: (scope: 'local' | 'review') => void
  fixChecks: () => void
  merge: (method: ReturnType<typeof resolveGitHubPRMergeMethods>['defaultMethod']) => void
  setAutoMerge: (enabled: boolean) => void
}

export type BuildMobileNextStepBarArgs = {
  step: SourceControlNextStep
  primaryAction: MobileSourceControlPrimaryAction
  createPrAction: MobileCreatePrAction
  pr: PRInfo | null
  prDetails: GitHubWorkItemDetails | null
  /** No review exists and Create is blocked; say why instead of hiding the bar (e.g. GitLab sign-in). */
  createBlocked: boolean
  /** The agent the AI buttons launch; null names it "AI". */
  agentName: string | null
  busy: {
    completingMerge: boolean
    agentLaunch: boolean
    /** The host can't launch agents from a phone yet; the notice says why. */
    agentUnavailable: boolean
    merge: boolean
    autoMerge: boolean
    ioBusy: boolean
    /** GitHub refused a PR mutation for good (e.g. no permission); retrying won't help. */
    prMutationsBlocked: boolean
  }
  handlers: MobileNextStepHandlers
}

export function buildMobileNextStepBar(args: BuildMobileNextStepBarArgs): MobileNextStepBarView {
  const { step, busy, handlers } = args
  const agent = args.agentName ?? translate('sourceControl.nextStep.genericAgent', 'AI')
  switch (step.kind) {
    case 'none':
      return args.createBlocked
        ? createReviewButton(args.createPrAction, false)
        : { kind: 'hidden' }
    case 'commit':
      return { kind: 'composer' }
    case 'remote':
      return remoteButton(args.primaryAction)
    case 'complete_merge':
      return button({
        label: busy.completingMerge
          ? translate('sourceControl.branchCard.completingMerge', 'Completing…')
          : translate('sourceControl.branchCard.completeMerge', 'Complete merge'),
        icon: 'complete',
        disabled: busy.ioBusy,
        loading: busy.completingMerge,
        onPress: handlers.completeMerge
      })
    case 'resolve_conflicts':
      return button({
        label: translate('sourceControl.nextStep.resolveWithAgent', 'Resolve with {{agent}}', {
          agent
        }),
        icon: 'agent',
        disabled: busy.agentLaunch || busy.agentUnavailable,
        loading: busy.agentLaunch,
        onPress: () => handlers.resolveConflicts(step.scope)
      })
    case 'create_review':
      return createReviewButton(args.createPrAction, step.pushFirst)
    case 'fix_checks':
      return button({
        label: translate('sourceControl.nextStep.fixWithAgent', 'Fix with {{agent}}', { agent }),
        icon: 'agent',
        disabled: busy.agentLaunch || busy.agentUnavailable,
        loading: busy.agentLaunch,
        reason: {
          lead: translate('sourceControl.nextStep.cantMergeYet', 'Can’t merge yet:'),
          text:
            step.failedChecks === 1
              ? translate('sourceControl.nextStep.checksFailing_one', '{{count}} check failing', {
                  count: step.failedChecks
                })
              : translate(
                  'sourceControl.nextStep.checksFailing_other',
                  '{{count}} checks failing',
                  {
                    count: step.failedChecks
                  }
                )
        },
        onPress: handlers.fixChecks
      })
    case 'merge_when_ready':
      return button({
        label: translate('sourceControl.nextStep.mergeWhenReady', 'Merge when ready'),
        icon: 'merge',
        tone: 'secondary',
        disabled: busy.autoMerge || busy.prMutationsBlocked,
        loading: busy.autoMerge,
        reason: { text: waitingReason(step, args) },
        onPress: () => handlers.setAutoMerge(true)
      })
    case 'auto_merge_on':
      return {
        kind: 'auto_merge_on',
        loading: busy.autoMerge,
        disabled: busy.prMutationsBlocked,
        onCancel: () => handlers.setAutoMerge(false)
      }
    case 'merge':
    case 'merge_blocked':
      return mergeButton(args, step.kind === 'merge')
    case 'merged':
      return { kind: 'merged', baseRef: args.pr?.baseRefName || null }
  }
}

function button(view: {
  label: string
  icon: MobileNextStepIcon
  tone?: MobileNextStepTone
  disabled?: boolean
  loading?: boolean
  reason?: MobileNextStepReason | null
  accessibilityHint?: string
  onPress: () => void
}): MobileNextStepBarView {
  return {
    kind: 'button',
    tone: 'primary',
    disabled: false,
    loading: false,
    reason: null,
    ...view
  }
}

function remoteButton(action: MobileSourceControlPrimaryAction): MobileNextStepBarView {
  const icon: MobileNextStepIcon =
    action.kind === 'pull' ? 'pull' : action.kind === 'sync' ? 'sync' : 'push'
  return button({
    label: action.label,
    icon,
    disabled: action.disabled,
    loading: action.loading,
    // Say why a remote step can't run rather than showing a dead button.
    reason: action.disabled && !action.loading ? { text: action.accessibilityHint } : null,
    accessibilityHint: action.accessibilityHint,
    onPress: action.onPress
  })
}

function createReviewButton(
  action: MobileCreatePrAction,
  pushFirst: boolean
): MobileNextStepBarView {
  return button({
    label: pushFirst
      ? translate('sourceControl.nextStep.pushAndCreateReview', 'Push & create {{review}}', {
          review: action.reviewLabel
        })
      : translate('sourceControl.nextStep.createReview', 'Create {{review}}', {
          review: action.reviewLabel
        }),
    icon: 'review',
    disabled: action.disabled,
    loading: action.loading,
    reason: action.hint ? { text: action.hint } : null,
    onPress: action.onPress
  })
}

function mergeButton(args: BuildMobileNextStepBarArgs, ready: boolean): MobileNextStepBarView {
  const pr = args.pr
  if (!pr) {
    return { kind: 'hidden' }
  }
  const method = resolveGitHubPRMergeMethods(pr.mergeMethodSettings ?? null).defaultMethod
  const merge = presentPrMerge(pr, method)
  return button({
    label: ready ? merge.label : translate('sourceControl.nextStep.merge', 'Merge'),
    icon: 'merge',
    tone: 'merge',
    disabled: !ready || args.busy.merge || args.busy.prMutationsBlocked,
    loading: args.busy.merge,
    reason: !ready && merge.hint ? { text: merge.hint } : null,
    onPress: () => args.handlers.merge(method)
  })
}

function waitingReason(
  step: Extract<SourceControlNextStep, { kind: 'merge_when_ready' }>,
  args: BuildMobileNextStepBarArgs
): string {
  if (step.pendingChecks > 0) {
    return step.pendingChecks === 1
      ? translate('sourceControl.nextStep.checksRunning_one', '{{count}} check still running', {
          count: step.pendingChecks
        })
      : translate('sourceControl.nextStep.checksRunning_other', '{{count}} checks still running', {
          count: step.pendingChecks
        })
  }
  if (step.mergeState === 'review_required') {
    const reviewer = args.prDetails ? getGitHubPRPrimaryReviewer(args.prDetails.item) : null
    return reviewer
      ? translate('sourceControl.nextStep.waitingOnReviewer', 'Waiting on review from {{login}}', {
          login: reviewer.login
        })
      : translate('sourceControl.nextStep.waitingOnReview', 'Waiting on review')
  }
  const pr = args.pr
  return pr
    ? (presentPrMerge(pr, resolveGitHubPRMergeMethods(pr.mergeMethodSettings ?? null).defaultMethod)
        .hint ?? '')
    : ''
}
