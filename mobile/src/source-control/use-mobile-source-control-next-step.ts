import { useCallback, useMemo, useState } from 'react'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useHostProtocolGates } from '../components/host-protocol-gates-context'
import { presentPrMerge } from '../components/pr-sidebar/pr-actions-state'
import { useMobilePrActions } from '../session/use-mobile-pr-actions'
import { useMobilePrAiTriage, type PrAiTriageKey } from '../session/use-mobile-pr-ai-triage'
import {
  buildPrFixChecksPrompt,
  buildResolveConflictsPrompt as buildReviewConflictsPrompt
} from '../session/pr-ai-triage-prompt'
import type { PrSidebarState } from '../session/mobile-pr-sidebar-state'
import type { PrSidebarLoadOptions } from '../session/use-mobile-pr-sidebar-controller'
import { buildResolveConflictsPrompt } from '../../../src/shared/source-control-conflict-prompts'
import { resolveGitHubPRMergeMethods } from '../../../src/shared/github/pull-request-merge-methods'
import type { GitHubPRMergeMethod } from '../../../src/shared/github/pull-request-types'
import { summarizeProviderChecks } from '../../../src/shared/provider-check-summary'
import { getBrokenChecks } from '../../../src/shared/pr-checks-fix-prompt'
import { resolveSourceControlCommitAreaPrimaryActionDecision } from '../../../src/shared/source-control-primary-action-decision'
import {
  resolveSourceControlNextStep,
  type SourceControlNextStepReview
} from '../../../src/shared/source-control-next-step-decision'
import { splitWorktreeIdForFilesystem } from '../../../src/shared/worktree/id'
import { MOBILE_COMPLETE_MERGE_ACTION_ID } from './mobile-source-control-conflict-actions'
import {
  buildMobileSourceControlDecisionInputs,
  type MobileSourceControlPrimaryAction,
  type MobileSourceControlReviewInputs
} from './mobile-source-control-primary-action'
import { buildMobileNextStepBar } from './mobile-source-control-next-step'
import { useMobileSourceControlAgentName } from './use-mobile-source-control-agent-name'
import type { MobileSourceControlState } from './use-mobile-source-control-state'

type Params = {
  worktreeId: string
  state: MobileSourceControlState
  primaryAction: MobileSourceControlPrimaryAction
  review: MobileSourceControlReviewInputs
  prState: PrSidebarState
  /** False on hosts without PR support; the bar then stops at Create PR. */
  reviewsSupported: boolean
  refetchPr: (options?: PrSidebarLoadOptions) => void
  headSha: string | null
  /** The Changes body shows git workflow failures; elsewhere the bar has to. */
  showWorkflowErrors: boolean
  /** Opens the PR tab's Merge sheet, which picks the method, instead of confirming the default. */
  onMerge?: () => void
}

export type MobileMergeConfirm = {
  title: string
  message: string
  confirmLabel: string
  onConfirm: () => void
  onCancel: () => void
}

export function useMobileSourceControlNextStep({
  worktreeId,
  state,
  primaryAction,
  review,
  prState,
  reviewsSupported,
  refetchPr,
  headSha,
  showWorkflowErrors,
  onMerge
}: Params) {
  const t = useMobileTranslation()
  const { client, connState, status, createPrAction, primaryActionArgs, busyAction } = state
  const readyPr = prState.kind === 'ready' ? prState.data : null
  const prNumber = readyPr?.pr.number ?? 0
  const prRepo = readyPr?.pr.prRepo ?? null
  const actions = useMobilePrActions({
    client,
    connState,
    worktreeId,
    prNumber,
    headSha,
    prRepo,
    refetch: refetchPr
  })
  const { hostCapabilities, statusPending, statusReadable } = useHostProtocolGates()
  const triage = useMobilePrAiTriage({
    client,
    connState,
    worktreeId,
    workspaceLabel: state.worktreeLabel,
    hostCapabilities,
    hostStatusPending: statusPending,
    hostStatusReadable: statusReadable
  })
  const [mergeMethod, setMergeMethod] = useState<GitHubPRMergeMethod | null>(null)

  // Merge and auto-merge apply optimistically, so read the PR through the actions engine.
  const pr = useMemo(
    () =>
      readyPr
        ? {
            ...readyPr.pr,
            state: actions.resolveState(readyPr.pr.state),
            autoMergeEnabled: actions.resolveAutoMerge(readyPr.pr.autoMergeEnabled ?? false)
          }
        : null,
    [actions, readyPr]
  )

  const { step, reviewAbsent } = useMemo(() => {
    const reviewInput: SourceControlNextStepReview =
      pr && readyPr
        ? {
            kind: 'github',
            pr,
            // The checks the fix prompt includes, so Fix never launches with nothing to fix.
            failedChecks: getBrokenChecks(readyPr.checks).length,
            pendingChecks: summarizeProviderChecks(readyPr.checks).pending
          }
        : reviewsSupported && (prState.kind === 'loading' || prState.kind === 'hidden')
          ? { kind: 'loading' }
          : { kind: 'none' }
    const next = resolveSourceControlNextStep({
      local: resolveSourceControlCommitAreaPrimaryActionDecision(
        buildMobileSourceControlDecisionInputs({ ...primaryActionArgs, review })
      ),
      conflictOperation: status?.conflictOperation,
      hasUnresolvedConflicts: primaryActionArgs.hasUnresolvedConflicts,
      hasChangesToCommit:
        primaryActionArgs.stagedCount > 0 || primaryActionArgs.stageablePaths.length > 0,
      reviewCreation: createPrAction.eligible
        ? createPrAction.pushFirst
          ? 'push_and_create'
          : 'create'
        : 'unavailable',
      review: reviewInput
    })
    return { step: next, reviewAbsent: reviewInput.kind === 'none' }
  }, [
    createPrAction.eligible,
    createPrAction.pushFirst,
    pr,
    prState.kind,
    primaryActionArgs,
    readyPr,
    review,
    reviewsSupported,
    status?.conflictOperation
  ])

  const agentActionId =
    step.kind === 'resolve_conflicts'
      ? 'resolveConflicts'
      : step.kind === 'fix_checks'
        ? 'fixChecks'
        : null
  const agentName = useMobileSourceControlAgentName({
    client,
    connState,
    worktreeId,
    hostCapabilities,
    actionId: agentActionId
  })

  const resolveConflicts = useCallback(
    (scope: 'local' | 'review') => {
      void triage.launch('resolve-conflicts', () => {
        if (scope === 'review' && readyPr) {
          return buildReviewConflictsPrompt({
            prNumber: readyPr.pr.number,
            baseRef: readyPr.pr.conflictSummary?.baseRef ?? readyPr.pr.baseRefName ?? null,
            files: readyPr.pr.conflictSummary?.files ?? [],
            worktreeId
          })
        }
        return buildResolveConflictsPrompt({
          conflictOperation: status?.conflictOperation ?? 'unknown',
          entries: (status?.entries ?? []).filter((entry) => entry.conflictStatus === 'unresolved'),
          worktreePath: splitWorktreeIdForFilesystem(worktreeId)?.worktreePath ?? null
        })
      })
    },
    [readyPr, status, triage, worktreeId]
  )

  const view = useMemo(
    () =>
      buildMobileNextStepBar({
        step,
        primaryAction,
        createPrAction,
        pr,
        prDetails: readyPr?.details ?? null,
        createBlocked: reviewAbsent && createPrAction.visible && Boolean(createPrAction.hint),
        agentName,
        busy: {
          completingMerge: busyAction === MOBILE_COMPLETE_MERGE_ACTION_ID,
          agentLaunch: triage.isBusy('fix-checks') || triage.isBusy('resolve-conflicts'),
          agentUnavailable: triage.availability !== 'available',
          merge: actions.isBusy({ kind: 'merge' }),
          autoMerge: actions.isBusy({ kind: 'autoMerge' }),
          ioBusy: busyAction !== null,
          prMutationsBlocked: actions.blocked !== null
        },
        handlers: {
          completeMerge: () => void state.completeMerge(),
          resolveConflicts,
          fixChecks: () => {
            if (readyPr) {
              void triage.launch('fix-checks', () =>
                buildPrFixChecksPrompt({
                  client,
                  worktreeId,
                  pr: readyPr.pr,
                  checks: readyPr.checks
                })
              )
            }
          },
          merge: onMerge ? () => onMerge() : setMergeMethod,
          setAutoMerge: (enabled) =>
            actions.setAutoMerge(
              enabled,
              pr
                ? resolveGitHubPRMergeMethods(pr.mergeMethodSettings ?? null).defaultMethod
                : undefined
            )
        }
      }),
    // t: labels are translated inside the builder.
    [
      actions,
      agentName,
      busyAction,
      client,
      createPrAction,
      onMerge,
      pr,
      primaryAction,
      readyPr,
      resolveConflicts,
      reviewAbsent,
      state,
      step,
      t,
      triage,
      worktreeId
    ]
  )

  const triageKey: PrAiTriageKey | null =
    step.kind === 'fix_checks'
      ? 'fix-checks'
      : step.kind === 'resolve_conflicts'
        ? 'resolve-conflicts'
        : null
  // The bar's agent button is the only one on either tab, so its launch notice shows under it.
  const agentNotice = triageKey
    ? { ...triage.noticeFor(triageKey), availability: triage.availability }
    : null
  const workflowError = showWorkflowErrors
    ? (state.actionError ?? state.commitFailureRecovery?.error ?? null)
    : null
  const notice = actions.blocked ?? actions.error ?? workflowError

  const mergeConfirm: MobileMergeConfirm | null =
    mergeMethod && pr
      ? {
          title: t('pullRequest.prActionsSection.mergeConfirmTitle', 'Merge pull request?'),
          message: presentPrMerge(pr, mergeMethod).confirmMessage,
          confirmLabel: t('pullRequest.prActionsSection.mergeButton', 'Merge'),
          onConfirm: () => {
            setMergeMethod(null)
            actions.merge(mergeMethod)
          },
          onCancel: () => setMergeMethod(null)
        }
      : null

  return {
    view,
    notice,
    agentNotice,
    mergeConfirm,
    triage,
    actions
  }
}
