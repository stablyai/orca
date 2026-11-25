import type {
  BrowserScreencastFormat,
  BrowserScreencastFrameMetadata
} from '../../../../shared/browser/screencast/browser-screencast-protocol'
import type { CapturePaintHold } from '../debugger/guest-paint-hold'

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
  /** True while a viewer holds frames its link cannot take yet; lowers quality during motion. */
  isViewerBacklogged?: () => boolean
  onEvent?: (event: BrowserScreencastEvent) => void
  onError?: (message: string) => void
  /** Why no first frame came, when the owner knows; otherwise the stream reports a plain timeout. */
  noFrameMessage?: () => string | undefined
  holdPaint: CapturePaintHold
}

export type BrowserScreencastViewport = Pick<
  BrowserScreencastOptions,
  'viewportWidth' | 'viewportHeight' | 'deviceScaleFactor' | 'mobile'
>

export type BrowserScreencastFrameBudget = Pick<
  BrowserScreencastOptions,
  'quality' | 'maxWidth' | 'maxHeight' | 'everyNthFrame' | 'minFrameIntervalMs'
>

export type BrowserScreencastLaneViewers = Pick<
  BrowserScreencastOptions,
  'onFrame' | 'isViewerBacklogged'
>

/** One encoding of the page's frames at its own size, quality and pace, for the viewers that share them. */
export type BrowserScreencastLane = {
  updateFrameBudget: (budget: BrowserScreencastFrameBudget) => Promise<void>
  stop: () => void
}

export type BrowserScreencastSession = {
  stop: () => void
  done: Promise<void>
  updateViewport: (viewport: BrowserScreencastViewport) => Promise<void>
  /** The lane opened from the start options. */
  firstLane: BrowserScreencastLane
  openLane: (
    budget: BrowserScreencastFrameBudget,
    viewers: BrowserScreencastLaneViewers
  ) => Promise<BrowserScreencastLane>
}

export type BrowserScreencastEvent =
  | {
      type: 'dialog'
      dialogType: string
      message: string
      defaultPromptText: string
      origin: string | null
    }
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
