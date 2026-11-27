import type {
  BrowserSetGrabModeArgs,
  BrowserSetGrabModeResult,
  BrowserAwaitGrabSelectionArgs,
  BrowserGrabResult,
  BrowserCancelGrabArgs,
  BrowserSetGrabLabelAvoidAreaArgs,
  BrowserGrabPickedElementPresentArgs,
  BrowserCaptureSelectionScreenshotArgs,
  BrowserCaptureSelectionScreenshotResult,
  BrowserExtractHoverArgs,
  BrowserExtractHoverResult,
  BrowserGrabActionShortcutArgs,
  GrabIntent
} from '../../../shared/browser/element-grab/browser-grab-types'
import type {
  BrowserCaptureCleanPageArgs,
  BrowserCleanPageCapture
} from '../../../shared/browser/element-grab/browser-grab-clean-capture'

/** Element picking in a page: arm, await a pick, cancel, and the keys a focused page forwards back. */
export type BrowserGrabApi = {
  setGrabMode: (args: BrowserSetGrabModeArgs) => Promise<BrowserSetGrabModeResult>
  awaitGrabSelection: (args: BrowserAwaitGrabSelectionArgs) => Promise<BrowserGrabResult>
  cancelGrab: (args: BrowserCancelGrabArgs) => Promise<boolean>
  /** Where the annotate palette covers the page, so the picker's hover label stays clear of it. */
  setGrabLabelAvoidArea: (args: BrowserSetGrabLabelAvoidAreaArgs) => Promise<boolean>
  /** False only when the page answers that no element matches; unknown counts as present. */
  grabPickedElementPresent: (args: BrowserGrabPickedElementPresentArgs) => Promise<boolean | null>
  captureSelectionScreenshot: (
    args: BrowserCaptureSelectionScreenshotArgs
  ) => Promise<BrowserCaptureSelectionScreenshotResult>
  extractHoverPayload: (args: BrowserExtractHoverArgs) => Promise<BrowserExtractHoverResult>
  /** Removes the picker and captures that same document in one serialized step; null when superseded. */
  captureCleanPage: (args: BrowserCaptureCleanPageArgs) => Promise<BrowserCleanPageCapture | null>
  onGrabModeToggle: (callback: (browserPageId: string, intent: GrabIntent) => void) => () => void
  onGrabPolicyRetired: (
    callback: (args: { browserPageId: string; requestId?: string }) => void
  ) => () => void
  onGrabActionShortcut: (callback: (args: BrowserGrabActionShortcutArgs) => void) => () => void
}
