import { useCallback, useRef, useState } from 'react'
import { triggerEdgeBump } from '../../platform/haptics/haptics'
import { returnToHostSessionList } from '../../navigation/session-list-back'
import type { HostStackHostRoute } from '../../navigation/host-stack-navigation'
import { useBackClaim } from '../../navigation/use-back-claim'
import { dropDocumentEditDraft } from '../../drafts/document-edit-draft-rows'

export function filePreviewSessionListLeave(
  router: { dismissTo: (href: HostStackHostRoute) => void },
  hostId: string | undefined
): (() => void) | null {
  if (!hostId) {
    return null
  }
  return () => {
    triggerEdgeBump()
    returnToHostSessionList(router, hostId)
  }
}

export type MobileFilePreviewBack = {
  confirmingDiscard: boolean
  /** Returns true when it handled the request, which is what a hardware back press reads. */
  requestBack: () => boolean
  /** Long-press: same unsaved check, then the session list instead of one step. */
  requestLeaveToSessionList: () => boolean
  stay: () => void
  discard: () => void
}

// Use ConfirmModal: React Native Web’s Alert.alert is a no-op, leaving Back with an unsaved draft unanswered.
// Claim Back through the platform seam; route handoff back asks the shell to pop the page’s native screen.
export function useMobileFilePreviewBack(options: {
  hasUnsavedDraft: boolean
  leave: () => void
  router?: { dismissTo: (href: HostStackHostRoute) => void }
  hostId?: string
  leaveToSessionList?: (() => void) | null
  // Runs before leaving with a discarded draft, so it is not offered back later.
  onDiscard?: () => void
}): MobileFilePreviewBack {
  const { hasUnsavedDraft, leave, onDiscard } = options
  const leaveToSessionList =
    options.leaveToSessionList ??
    (options.router ? filePreviewSessionListLeave(options.router, options.hostId) : null)
  const [asking, setAsking] = useState(false)
  const [askedAbout, setAskedAbout] = useState(hasUnsavedDraft)
  const pendingLeave = useRef(leave)

  // Clear asking during render when the draft disappears; an effect would flash the old prompt and retaining the flag would reopen it on the next edit.
  if (askedAbout !== hasUnsavedDraft) {
    setAskedAbout(hasUnsavedDraft)
    if (!hasUnsavedDraft) {
      setAsking(false)
    }
  }

  const confirmingDiscard = asking && hasUnsavedDraft

  const requestBack = useCallback(() => {
    pendingLeave.current = leave
    if (hasUnsavedDraft) {
      setAsking(true)
      return true
    }
    leave()
    return true
  }, [hasUnsavedDraft, leave])

  const requestLeaveToSessionList = useCallback(() => {
    const go = leaveToSessionList ?? leave
    pendingLeave.current = go
    if (hasUnsavedDraft) {
      setAsking(true)
      return true
    }
    go()
    return true
  }, [hasUnsavedDraft, leave, leaveToSessionList])

  const stay = useCallback(() => setAsking(false), [])

  const discard = useCallback(() => {
    setAsking(false)
    onDiscard?.()
    pendingLeave.current()
  }, [onDiscard])

  useBackClaim(requestBack)

  return { confirmingDiscard, requestBack, requestLeaveToSessionList, stay, discard }
}

/** Back for a preview document, including dropping its edit draft when the reader discards. */
export function useMobileFilePreviewBackWithDraft(options: {
  hasUnsavedDraft: boolean
  router: { back: () => void; dismissTo: (href: HostStackHostRoute) => void }
  hostId: string | undefined
  editDraftKey: string | null
}): { back: MobileFilePreviewBack; dropEditDraft: () => void } {
  const { hasUnsavedDraft, router, hostId, editDraftKey } = options
  // Unmount retires pending saves; a refused back keeps the document and its save alive.
  const leave = useCallback(() => router.back(), [router])
  const dropEditDraft = (): void => {
    if (editDraftKey) {
      dropDocumentEditDraft(editDraftKey)
    }
  }
  const back = useMobileFilePreviewBack({
    hasUnsavedDraft,
    leave,
    router,
    hostId,
    onDiscard: dropEditDraft
  })
  return { back, dropEditDraft }
}
