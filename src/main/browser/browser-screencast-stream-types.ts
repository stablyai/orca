import type {
  BrowserScreencastFormat,
  BrowserScreencastFrameMetadata
} from '../../shared/browser-screencast-protocol'

export type BrowserScreencastOptions = {
  format: BrowserScreencastFormat
  quality: number
  maxWidth: number
  maxHeight: number
  viewportWidth?: number
  viewportHeight?: number
  deviceScaleFactor?: number
  mobile?: boolean
  everyNthFrame: number
  minFrameIntervalMs: number
  onFrame: (bytes: Uint8Array<ArrayBufferLike>) => boolean | void
  onEvent?: (event: BrowserScreencastEvent) => void
  onError?: (message: string) => void
}

export type BrowserScreencastViewport = Pick<
  BrowserScreencastOptions,
  'viewportWidth' | 'viewportHeight' | 'deviceScaleFactor' | 'mobile'
>

export type BrowserScreencastFrameBudget = Pick<
  BrowserScreencastOptions,
  'quality' | 'maxWidth' | 'maxHeight' | 'everyNthFrame' | 'minFrameIntervalMs'
>

export type BrowserScreencastSession = {
  stop: () => void
  done: Promise<void>
  updateViewport: (viewport: BrowserScreencastViewport) => Promise<void>
  updateFrameBudget: (budget: BrowserScreencastFrameBudget) => Promise<void>
  /**
   * Answers the dialog this stream reported, and says whether there was one to answer.
   *
   * Only the CDP session that received `Page.javascriptDialogOpening` may answer it; anything
   * that attaches afterwards is told no dialog is showing, and every renderer-bound command it
   * sends first blocks behind the dialog it is trying to clear.
   */
  settleDialog: (accept: boolean, promptText?: string) => Promise<boolean>
}

export type BrowserScreencastEvent =
  | { type: 'dialog'; dialogType: string; message: string }
  | { type: 'dialogClosed' }

export type PendingScreencastFrame = {
  metadata: BrowserScreencastFrameMetadata
  image: Uint8Array
  sessionId?: number
}

export type ScreencastImageSize = {
  width: number
  height: number
}
