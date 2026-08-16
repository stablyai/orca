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

export type BrowserScreencastSession = { stop: () => void; done: Promise<void> }

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
