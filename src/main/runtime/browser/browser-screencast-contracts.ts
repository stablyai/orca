import type { BrowserScreencastResult } from '../../../shared/runtime-types'
import type {
  BrowserScreencastFrameBudget,
  BrowserScreencastSession,
  BrowserScreencastViewport
} from '../../browser/browser-screencast-stream-types'
import type { ScreencastSubscriberDeliveryState } from '../browser-screencast-ghost-subscriber-eviction'
import type { RpcBinarySender } from '../rpc/rpc-binary-sender'
import type { BrowserCommandTargetParams } from './browser-command-contracts'

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
} & BrowserCommandTargetParams

export type BrowserScreencastStartResult = {
  subscriptionId: string
  ready: Extract<BrowserScreencastResult, { type: 'ready' }>
  // The frame budget and the page's dialog belong to the shared page, not to one subscriber's handle.
  session: Omit<BrowserScreencastSession, 'updateFrameBudget' | 'settleDialog'>
  // Why: callers gate frames until they have emitted `ready`, and the snapshot captured
  // for a joining subscriber lands inside that window. This replays it once the gate opens.
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
  // Why: identifies the viewer across reconnects, which the RPC connectionId cannot — a new
  // socket never reuses the old id, so a reconnecting device would stack a second subscription.
  pairedDeviceId?: string
  delivery: ScreencastSubscriberDeliveryState
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
