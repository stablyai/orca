import { useMemo } from 'react'
import {
  Copy,
  FileText,
  ListChecks,
  MessageSquarePlus,
  Send,
  Trash2,
  Undo2
} from 'lucide-react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useWorkspaceOnPairedHost } from '../navigation/workspace-execution-host'
import type { useMobileDiffReviewController } from '../session/use-mobile-diff-review-controller'
import type { ActionSheetAction } from './ActionSheetModal'

// The review screen's ⋯ menu: rarer file actions, the notes, and Discard last.
export function useMobileDiffReviewOverflowActions(
  controller: ReturnType<typeof useMobileDiffReviewController>,
  options: { showPullRequest: boolean }
) {
  const t = useMobileTranslation()
  const sessionTabsAvailable = useWorkspaceOnPairedHost()
  const { showPullRequest } = options
  return useMemo<ActionSheetAction[]>(() => {
    const item = controller.currentItem
    const busy = controller.busyAction !== null
    return [
      ...(item?.canUnstage
        ? [
            {
              id: 'unstage',
              label: t('components.diffReviewDrawers.unstageFile', 'Unstage'),
              icon: Undo2,
              disabled: busy,
              onPress: () => void controller.runGitMutation('git.unstage', item)
            }
          ]
        : []),
      {
        id: 'addFileNote',
        label: t('components.diffReviewDrawers.addFileNote', 'Add File Note'),
        icon: MessageSquarePlus,
        disabled: !item || item.scope === 'commit',
        // The note composer is a sheet; iOS can't present it over the menu.
        closeBeforePress: true,
        onPress: () => controller.openComposer(0)
      },
      {
        id: 'copyNotes',
        label: t('components.diffReviewDrawers.copyNotes', 'Copy Notes'),
        icon: Copy,
        disabled:
          controller.screenState.kind !== 'ready' || controller.screenState.comments.length === 0,
        onPress: () => void controller.copyNotes()
      },
      {
        id: 'sendUnsentNotes',
        label: t('components.diffReviewDrawers.sendUnsentNotes', 'Send Unsent Notes'),
        icon: Send,
        disabled: controller.unsentComments.length === 0,
        // Send Notes is a sheet; iOS can't present it over the menu.
        closeBeforePress: true,
        onPress: () => void controller.openSendSheet()
      },
      {
        id: 'clearSentNotes',
        label: t('components.diffReviewDrawers.clearSentNotes', 'Clear Sent Notes'),
        icon: Trash2,
        disabled:
          controller.screenState.kind !== 'ready' ||
          controller.screenState.comments.every((comment) => comment.sentAt === undefined),
        onPress: () => void controller.clearSentNotes()
      },
      ...(showPullRequest
        ? [
            {
              id: 'pullRequest',
              label: t('components.diffReviewDrawers.pullRequest', 'Pull Request'),
              icon: ListChecks,
              closeBeforePress: true,
              onPress: () => controller.openPRSidebar()
            }
          ]
        : []),
      ...(sessionTabsAvailable
        ? [
            {
              id: 'openInSession',
              label: t('components.diffReviewDrawers.openInSession', 'Open in Session'),
              icon: FileText,
              disabled: !item || item.scope === 'branch' || item.scope === 'commit',
              onPress: () => void controller.openInSession()
            }
          ]
        : []),
      ...(item?.canDiscard
        ? [
            {
              id: 'discard',
              label: t('components.diffReviewDrawers.discardChanges', 'Discard Changes'),
              icon: Trash2,
              destructive: true,
              disabled: busy,
              // The confirm is a sheet; iOS can't present it over the menu.
              closeBeforePress: true,
              onPress: () => controller.openSheet({ kind: 'discard', target: item })
            }
          ]
        : [])
    ]
  }, [controller, sessionTabsAvailable, showPullRequest, t])
}
