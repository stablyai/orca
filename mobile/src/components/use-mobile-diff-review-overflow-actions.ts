import { useMemo } from 'react'
import { Check, Copy, FileText, Send, Trash2, X } from 'lucide-react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useWorkspaceOnPairedHost } from '../navigation/workspace-execution-host'
import type { useMobileDiffReviewController } from '../session/use-mobile-diff-review-controller'
import type { ActionSheetAction } from './ActionSheetModal'

// The review screen's ⋯ menu.
export function useMobileDiffReviewOverflowActions(
  controller: ReturnType<typeof useMobileDiffReviewController>
) {
  const t = useMobileTranslation()
  const sessionTabsAvailable = useWorkspaceOnPairedHost()
  return useMemo<ActionSheetAction[]>(() => {
    const stageable = controller.reviewedUnstagedCount
    return [
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
      {
        id: 'stageReviewedFiles',
        label: t('components.diffReviewDrawers.stageReviewedFiles', 'Stage Reviewed Files'),
        icon: Check,
        disabled: stageable === 0 || controller.busyAction !== null,
        ...(stageable > 0
          ? {
              hint:
                stageable === 1
                  ? t(
                      'components.diffReviewDrawers.stageableFiles_one',
                      '{{count}} reviewed unstaged files can be staged',
                      { count: stageable }
                    )
                  : t(
                      'components.diffReviewDrawers.stageableFiles_other',
                      '{{count}} reviewed unstaged files can be staged',
                      { count: stageable }
                    )
            }
          : {}),
        onPress: () => void controller.stageReviewedFiles()
      },
      {
        id: 'markUnreviewed',
        label: t('components.diffReviewDrawers.markUnreviewed', 'Mark Unreviewed'),
        icon: X,
        disabled:
          controller.screenState.kind !== 'ready' ||
          !controller.currentItem ||
          !controller.currentItem.isReviewed,
        onPress: () => void controller.markUnreviewed()
      },
      ...(sessionTabsAvailable
        ? [
            {
              id: 'openInSession',
              label: t('components.diffReviewDrawers.openInSession', 'Open in Session'),
              icon: FileText,
              disabled: !controller.currentItem || controller.currentItem.scope === 'branch',
              onPress: () => void controller.openInSession()
            }
          ]
        : [])
    ]
  }, [controller, sessionTabsAvailable, t])
}
