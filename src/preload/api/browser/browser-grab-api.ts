import type {
  BrowserSetGrabModeArgs,
  BrowserSetGrabModeResult,
  BrowserAwaitGrabSelectionArgs,
  BrowserGrabResult,
  BrowserCancelGrabArgs,
  BrowserCaptureSelectionScreenshotArgs,
  BrowserCaptureSelectionScreenshotResult,
  BrowserExtractHoverArgs,
  BrowserExtractHoverResult,
  BrowserCaptureCleanPage,
  GrabIntent
} from '../../../shared/browser/element-grab/browser-grab-types'

/** The page element picker and Draw's clean page capture. */
export type BrowserGrabApi = {
  setGrabMode: (args: BrowserSetGrabModeArgs) => Promise<BrowserSetGrabModeResult>
  awaitGrabSelection: (args: BrowserAwaitGrabSelectionArgs) => Promise<BrowserGrabResult>
  cancelGrab: (args: BrowserCancelGrabArgs) => Promise<boolean>
  captureSelectionScreenshot: (
    args: BrowserCaptureSelectionScreenshotArgs
  ) => Promise<BrowserCaptureSelectionScreenshotResult>
  extractHoverPayload: (args: BrowserExtractHoverArgs) => Promise<BrowserExtractHoverResult>
  captureCleanPage: BrowserCaptureCleanPage
  /** Retires a clean capture the renderer gave up on: stages not yet started are skipped. */
  retireCleanCapture: (args: { attemptId: string }) => Promise<void>
  onGrabModeToggle: (callback: (browserPageId: string, intent: GrabIntent) => void) => () => void
  onGrabActionShortcut: (
    callback: (args: { browserPageId: string; key: 'c' | 's' }) => void
  ) => () => void
}
