import { useState } from 'react'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useClipboardWriter } from '../../platform/clipboard'
import { triggerError, triggerSuccess } from '../../platform/haptics'
import { openMobilePrUrl } from '../mobile-pr-url'
import type { ActionSheetAction } from '../ActionSheetModal'
import { canEditPRTitle } from '../../session/pr-title-edit'
import { resolveGitHubPRMergeMethods } from '../../../../src/shared/github/pull-request-merge-methods'
import { resolveGitHubPRMergeState } from '../../../../src/shared/github/pull-request-merge-state'
import {
  MOBILE_GITHUB_MARK_PR_DRAFT_RUNTIME_CAPABILITY,
  MOBILE_GITHUB_MARK_PR_READY_RUNTIME_CAPABILITY
} from '../../../../src/shared/source-control-runtime-capabilities'
import { useRouteCapability } from '../../transport/use-workspace-client'
import type { MobilePrTab } from './use-mobile-pr-tab'

// Everything that should not compete with Merge; Close is red and last.
export function usePrTabMenuGroups(
  tab: MobilePrTab,
  onRefresh: () => void
): ActionSheetAction[][] | null {
  const t = useMobileTranslation()
  const clipboard = useClipboardWriter()
  const canMarkReady = useRouteCapability(MOBILE_GITHUB_MARK_PR_READY_RUNTIME_CAPABILITY)
  // Older hosts lack github.markPRDraft, so they never offer it.
  const canMarkDraft = useRouteCapability(MOBILE_GITHUB_MARK_PR_DRAFT_RUNTIME_CAPABILITY)
  const [copied, setCopied] = useState(false)
  if (tab.state.kind !== 'ready') {
    return null
  }
  const { actions } = tab
  const pr = tab.state.data.pr
  const state = actions.resolveState(pr.state)
  const autoMerge = actions.resolveAutoMerge(pr.autoMergeEnabled ?? false)
  const decision = resolveGitHubPRMergeState({ ...pr, state, autoMergeEnabled: autoMerge })
  const { defaultMethod } = resolveGitHubPRMergeMethods(pr.mergeMethodSettings ?? null)

  const web: ActionSheetAction[] = pr.url
    ? [
        {
          id: 'openOnGitHub',
          label: t('pullRequest.menu.openOnGitHub', 'Open on GitHub'),
          closeBeforePress: true,
          onPress: () => openMobilePrUrl(pr.url)
        },
        {
          id: 'copyLink',
          label: copied
            ? t('pullRequest.menu.copied', 'Copied')
            : t('pullRequest.menu.copyLink', 'Copy link'),
          onPress: () => {
            void clipboard.writeText(pr.url).then(
              () => {
                triggerSuccess()
                setCopied(true)
              },
              () => triggerError()
            )
          }
        }
      ]
    : []
  const edit: ActionSheetAction[] = []
  if (canEditPRTitle(state)) {
    edit.push({
      id: 'editTitle',
      label: t('pullRequest.menu.editTitle', 'Edit title'),
      closeBeforePress: true,
      onPress: tab.openEditTitleSheet
    })
  }
  if (decision.autoMergeAction !== null) {
    edit.push({
      id: 'autoMerge',
      label: t('pullRequest.menu.autoMerge', 'Auto-merge'),
      checked: autoMerge,
      loading: actions.isBusy({ kind: 'autoMerge' }),
      onPress: () => actions.setAutoMerge(!autoMerge, autoMerge ? undefined : defaultMethod)
    })
  }
  if (state === 'draft' && canMarkReady) {
    edit.push({
      id: 'markReady',
      label: t('pullRequest.prActionsSection.markReadyButton', 'Ready for review'),
      closeBeforePress: true,
      onPress: actions.markReadyForReview
    })
  } else if (state === 'open' && canMarkDraft) {
    edit.push({
      id: 'markDraft',
      label: t('pullRequest.menu.markDraft', 'Mark as draft'),
      closeBeforePress: true,
      onPress: actions.markDraft
    })
  }
  const manage: ActionSheetAction[] = [
    {
      id: 'refresh',
      label: t('pullRequest.menu.refresh', 'Refresh'),
      closeBeforePress: true,
      onPress: onRefresh
    },
    {
      id: 'unlink',
      label: t('pullRequest.menu.unlink', 'Unlink from workspace'),
      disabled: tab.unlinking,
      closeBeforePress: true,
      onPress: () => tab.setConfirm('unlink')
    }
  ]
  if (state === 'open' || state === 'draft') {
    manage.push({
      id: 'close',
      label: t('pullRequest.menu.close', 'Close pull request'),
      destructive: true,
      closeBeforePress: true,
      onPress: () => tab.setConfirm('close')
    })
  } else if (state === 'closed') {
    manage.push({
      id: 'reopen',
      label: t('pullRequest.prActionsSection.reopenAccessibilityLabel', 'Reopen pull request'),
      closeBeforePress: true,
      onPress: () => tab.setConfirm('reopen')
    })
  }
  return [web, edit, manage].filter((group) => group.length > 0)
}
