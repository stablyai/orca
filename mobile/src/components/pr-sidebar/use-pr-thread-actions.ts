import { useMemo } from 'react'
import type { MobilePrCommentActions } from '../../session/use-mobile-pr-comment-actions'
import type { PRCommentRepoSlug, PrThreadActions } from './PrThreadRow'

// Stable per-row callbacks, so an unrelated timeline update leaves every thread row alone.
export function usePrThreadActions(
  actions: MobilePrCommentActions | undefined,
  prRepo: PRCommentRepoSlug | null | undefined
): PrThreadActions | undefined {
  return useMemo<PrThreadActions | undefined>(
    () =>
      actions
        ? {
            reply: actions.reply,
            toggleResolve: actions.toggleResolve,
            editComment: actions.editComment,
            deleteComment: actions.deleteComment,
            isReplyBusy: actions.isReplyBusy,
            isResolveBusy: actions.isResolveBusy,
            isEditBusy: actions.isEditBusy,
            isDeleteBusy: actions.isDeleteBusy,
            prRepo: prRepo ?? null
          }
        : undefined,
    [actions, prRepo]
  )
}
