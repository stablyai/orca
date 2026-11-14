import type { BrowserScreencastResult } from '../../../../shared/browser/runtime/runtime-browser-contracts'
import type {
  BrowserScreencastFrameBudget,
  BrowserScreencastSession,
  BrowserScreencastViewport
} from '../../../browser/cdp/screencast/browser-screencast-stream-types'
import type { ScreencastSubscriberDeliveryState } from './browser-screencast-ghost-subscriber-eviction'
import type { BrowserScreencastFrameCredit } from './browser-screencast-frame-credit'
import type { RpcBinarySender } from '../../rpc/transports/rpc-binary-sender'
import type { BrowserCommandTargetParams } from '../commands/browser-command-contracts'

export type BrowserScreencastParams = {
  format: 'jpeg' | 'png'
  quality?: number
  maxWidth?: number
  maxHeight?: number
  viewportWidth?: number
  viewportHeight?: number
  deviceScaleFactor?: number
  mobile?: boolean
  everyNthFrame?: number
  minFrameIntervalMs?: number
  // The viewer acks frames with browser.screencast.ack; `ready` echoes `frameAck: true`.
  frameAck?: 1
} & BrowserCommandTargetParams

export type BrowserScreencastStartResult = {
  subscriptionId: string
  ready: Extract<BrowserScreencastResult, { type: 'ready' }>
  // Shared-page budget ownership must not leak through subscriber handles.
  session: Omit<BrowserScreencastSession, 'updateFrameBudget'>
  // Replay the joining snapshot once the caller's pre-ready gate opens.
  flushPendingFrame: () => void
}

export type ActiveBrowserScreencastSubscriber = {
  sendBinary: RpcBinarySender
  emit?: (event: BrowserScreencastResult) => void
  done: Promise<void>
  resolveDone: () => void
  viewport: BrowserScreencastViewport
  budget: BrowserScreencastFrameBudget
  pendingFrame: Uint8Array<ArrayBufferLike> | null
  pendingFrameRetry: ReturnType<typeof setTimeout> | null
  // Device identity survives reconnects; connection ids cannot replace stale subscriptions.
  pairedDeviceId?: string
  delivery: ScreencastSubscriberDeliveryState
  // Present when the viewer acks frames; `release` unregisters it from acks.
  frameCredit: { credit: BrowserScreencastFrameCredit; release: () => void } | null
}

export type ActiveBrowserScreencastPage = {
  format: 'jpeg' | 'png'
  session: BrowserScreencastSession | null
  started: Promise<BrowserScreencastSession>
  stopping: boolean
  subscribers: Map<string, ActiveBrowserScreencastSubscriber>
  viewportOwnerSubscriptionId: string | null
  appliedBudget: BrowserScreencastFrameBudget
}
