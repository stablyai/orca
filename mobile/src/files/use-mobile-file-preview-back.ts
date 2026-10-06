import { useCallback, useState } from 'react'
import { useBackClaim } from '../navigation/use-back-claim'

export type MobileFilePreviewBack = {
  /** Whether the screen is asking about an unsaved draft instead of leaving. */
  confirmingDiscard: boolean
  /** Returns true when it handled the request, which is what a hardware back press reads. */
  requestBack: () => boolean
  stay: () => void
  discard: () => void
}

/**
 * Leaving the preview, and the one question that can stop it.
 *
 * The prompt is a `ConfirmModal` rather than `Alert.alert`, because React Native Web's `Alert` is
 * `static alert() {}` — a silent no-op. Inside the shell's page that turned Back with an unsaved
 * draft into a button that did nothing at all: no prompt, and no navigation either.
 *
 * `ConfirmModal` is what every other confirm in this app uses, and it keeps the modal semantics the
 * native screen had before the page existed. It is a `BottomDrawer`, which C3 first wrote around
 * because C1.9 had Reanimated's animated styles never reaching the DOM node on WKWebView; C1.10
 * (`b7c06900e2`) fixed that by giving the mapper hooks a dependency array, and the drawer render
 * check now holds it on WebKit as well as Chromium.
 *
 * The claim runs on both platforms through one seam: the hardware key natively, and the shell's
 * key inside the page. `leave` is the route handoff's own `back`, which asks the shell to pop the
 * screen the page was pushed onto, so the prompt and what follows it mean the same thing on either.
 */
export function useMobileFilePreviewBack(options: {
  hasUnsavedDraft: boolean
  leave: () => void
}): MobileFilePreviewBack {
  const { hasUnsavedDraft, leave } = options
  const [asking, setAsking] = useState(false)
  const [askedAbout, setAskedAbout] = useState(hasUnsavedDraft)

  // Adjusted during render, not in an effect: an effect that answered this would paint one frame
  // still asking, which is the shape React Doctor names.
  //
  // The request belongs to the draft it was made about. `asking && hasUnsavedDraft` hides the
  // prompt when a save or a revert empties the draft, but on its own it leaves the flag set, so
  // the next edit put the prompt back with no Back request behind it. Dropping the request when
  // the draft goes is what ends it with the thing it was about.
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
