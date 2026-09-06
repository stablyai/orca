import type { BrowserPointerModifier } from '../browser/MobileBrowserPointerModifiers'
import type { MobileBrowserScreencastRequest } from '../browser/browser-screencast-request'
import type {
  BrowserScreencastFrame,
  BrowserScreencastFrameMetadata
} from '../transport/browser-screencast-protocol'

export type HostSessionBrowserTarget = {
  workspaceId: string
  pageId: string
}

export type HostSessionBrowserEvent =
  | {
      type: 'ready' | 'navigation'
      tab: {
        url: string
        title: string
        canGoBack: boolean
        canGoForward: boolean
      }
    }
  | { type: 'end' }
  | { type: 'dialog'; dialogType: string; message: string }
  | { type: 'dialogClosed' }
  | { type: 'error'; message: string }

export type HostSessionBrowserOperations = {
  subscribe(
    target: HostSessionBrowserTarget,
    request: MobileBrowserScreencastRequest,
    listener: {
      onEvent: (event: HostSessionBrowserEvent) => void
      onFrame: (frame: BrowserScreencastFrame) => void
      onError: (error: Error) => void
    }
  ): () => void
  navigate(target: HostSessionBrowserTarget, url: string): Promise<{ url: string }>
  scroll(
    target: HostSessionBrowserTarget,
    point: { x: number; y: number },
    delta: { dx: number; dy: number }
  ): Promise<void>
  click(
    target: HostSessionBrowserTarget,
    point: { x: number; y: number },
    button: 'left' | 'right',
    modifiers: BrowserPointerModifier[],
    radius?: number
  ): Promise<void>
  insertText(target: HostSessionBrowserTarget, text: string): Promise<void>
  keypress(
    target: HostSessionBrowserTarget,
    key: 'Enter' | 'Backspace' | 'Tab' | 'Escape'
  ): Promise<void>
  dialog(target: HostSessionBrowserTarget, action: 'accept' | 'dismiss'): Promise<void>
  back(target: HostSessionBrowserTarget): Promise<void>
  forward(target: HostSessionBrowserTarget): Promise<void>
  reload(target: HostSessionBrowserTarget): Promise<void>
}

export function hostSessionBrowserFrameMetadataEqual(
  left: BrowserScreencastFrameMetadata,
  right: BrowserScreencastFrameMetadata
): boolean {
  return (
    left.offsetTop === right.offsetTop &&
    left.pageScaleFactor === right.pageScaleFactor &&
    left.deviceWidth === right.deviceWidth &&
    left.deviceHeight === right.deviceHeight &&
    left.imageWidth === right.imageWidth &&
    left.imageHeight === right.imageHeight &&
    left.scrollOffsetX === right.scrollOffsetX &&
    left.scrollOffsetY === right.scrollOffsetY &&
    left.timestamp === right.timestamp
  )
}
