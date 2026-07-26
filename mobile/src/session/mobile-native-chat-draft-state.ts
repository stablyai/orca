import { useCallback, type RefObject } from 'react'
import type { MobileNativeChatSendOrigin } from './mobile-native-chat-draft-contract'

type Drafts = Record<string, string>
type DraftUpdater = (update: (previous: Drafts) => Drafts) => void

export function clearMobileNativeChatDraftForSend(
  drafts: Drafts,
  revisions: Record<string, number>,
  origin: MobileNativeChatSendOrigin,
  text: string
): Drafts {
  return (revisions[origin.draftKey] ?? 0) === origin.draftEditRevision &&
    (drafts[origin.draftKey] ?? '').trim() === text.trim()
    ? { ...drafts, [origin.draftKey]: '' }
    : drafts
}

export function restoreRejectedMobileNativeChatDraft(
  drafts: Drafts,
  revisions: Record<string, number>,
  origin: MobileNativeChatSendOrigin,
  text: string
): Drafts {
  return (revisions[origin.draftKey] ?? 0) === origin.draftEditRevision &&
    (drafts[origin.draftKey] ?? '') === ''
    ? { ...drafts, [origin.draftKey]: text }
    : drafts
}

export function useMobileNativeChatDraftMutations(
  updateDrafts: DraftUpdater,
  revisionsRef: RefObject<Record<string, number>>
) {
  const clearDraftForSend = useCallback(
    (origin: MobileNativeChatSendOrigin, text: string) =>
      updateDrafts((drafts) =>
        clearMobileNativeChatDraftForSend(drafts, revisionsRef.current, origin, text)
      ),
    [revisionsRef, updateDrafts]
  )
  const restoreRejectedDraft = useCallback(
    (origin: MobileNativeChatSendOrigin, text: string) =>
      updateDrafts((drafts) =>
        restoreRejectedMobileNativeChatDraft(drafts, revisionsRef.current, origin, text)
      ),
    [revisionsRef, updateDrafts]
  )
  return { clearDraftForSend, restoreRejectedDraft }
}
