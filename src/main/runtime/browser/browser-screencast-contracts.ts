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
  // Shared-page budget/dialog ownership must not leak through subscriber handles.
  session: Omit<BrowserScreencastSession, 'updateFrameBudget' | 'settleDialog'>
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
