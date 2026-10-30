import { useCallback, useState } from 'react'
import { useBackClaim } from '../navigation/use-back-claim'

export type MobileFilePreviewBack = {
  confirmingDiscard: boolean
  /** Returns true when it handled the request, which is what a hardware back press reads. */
  requestBack: () => boolean
  stay: () => void
  discard: () => void
}

// Use ConfirmModal: React Native Web’s Alert.alert is a no-op, leaving Back with an unsaved draft unanswered.
// Claim Back through the platform seam; route handoff back asks the shell to pop the page’s native screen.
export function useMobileFilePreviewBack(options: {
  hasUnsavedDraft: boolean
  leave: () => void
}): MobileFilePreviewBack {
  const { hasUnsavedDraft, leave } = options
  const [asking, setAsking] = useState(false)
  const [askedAbout, setAskedAbout] = useState(hasUnsavedDraft)

  // Clear asking during render when the draft disappears; an effect would flash the old prompt and retaining the flag would reopen it on the next edit.
  if (askedAbout !== hasUnsavedDraft) {
    setAskedAbout(hasUnsavedDraft)
    if (!hasUnsavedDraft) {
      setAsking(false)
    }
  }

  const confirmingDiscard = asking && hasUnsavedDraft

  const requestBack = useCallback(() => {
    if (hasUnsavedDraft) {
      setAsking(true)
      return true
    }
    leave()
    return true
  }, [hasUnsavedDraft, leave])

  const stay = useCallback(() => setAsking(false), [])

  const discard = useCallback(() => {
    setAsking(false)
    leave()
  }, [leave])

  useBackClaim(requestBack)

  return { confirmingDiscard, requestBack, stay, discard }
}
