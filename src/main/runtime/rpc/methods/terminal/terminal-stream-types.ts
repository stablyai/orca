import type { TerminalOscLinkRange } from '../../../../../shared/terminal-osc-link-ranges'
import type { TerminalSnapshotUnavailableReason } from '../../../../../shared/terminal-snapshot-unavailability'
import type {
  TerminalOutputFrameChunk,
  TerminalOutputMeta
} from '../../terminal-output-frame-chunks'
import type { TerminalOutputBatcher } from './terminal-output-batcher'

export type SnapshotFrameOptions = {
  kind: 'scrollback' | 'resized'
  cols: number
  rows: number
  data: string
  requestId?: number
  displayMode?: string
  reason?: string
  seq?: number
  cwd?: string | null
  truncated?: boolean
  truncatedByByteBudget?: boolean
  /** History rows this image carries above its screen; 0 tells the client to keep its own. */
  scrollbackRows?: number
  // Distinguish temporary unavailability from an empty buffer; omit on success.
  unavailable?: TerminalSnapshotUnavailableReason
  source?: 'headless' | 'renderer'
  oscLinks?: TerminalOscLinkRange[]
  pendingEscapeTailAnsi?: string
  /** Effective kitty flags proven at this frame's own `seq`. */
  kittyKeyboardFlags?: number
  alternateScreen?: boolean
  terminalOwner?: 'shell'
}

export type SerializedSnapshot = {
  data: string
  scrollbackAnsi?: string
  cols: number
  rows: number
  seq?: number
  cwd?: string | null
  source?: 'headless' | 'renderer'
  oscLinks?: TerminalOscLinkRange[]
  scrollbackRows: number
  truncatedByByteBudget: boolean
  pendingEscapeTailAnsi?: string
  kittyKeyboardFlags?: number
  alternateScreen?: boolean
  terminalOwner?: 'shell'
} | null

export type TerminalViewportClient = {
  id: string
  type?: 'mobile' | 'desktop'
}

export type TerminalMultiplexStream = {
  streamId: number
  terminal: string
  ptyId: string
  client: TerminalViewportClient | undefined
  isMobile: boolean
  ackOutput: boolean
  ackInFlightBytes: number
  ackWindowBytes: number
  supportsOutputPause: boolean
  // Why: lets the client skip the reveal snapshot when a pause discarded nothing.
  supportsOutputPauseDropNotice: boolean
  pausedOutputDropNoticeSent: boolean
  supportsWriteUnavailable: boolean
  // Also sends WriteUnavailable unprompted when the PTY's daemon endpoint drops.
  supportsEndpointLossNotice: boolean
  // Set only when the client negotiated `inputAck`; sequenced Input frames are then deduped and acked.
  inputSessionId: string | null
  outputPaused: boolean
  supportsDesktopViewportClaims: boolean
  desktopClaimTail: Promise<boolean>
  // Only this stream's floor may be released on detach.
  registeredRemoteDesktopDriver: boolean
  remoteDesktopSubscriptionKey: string
  pendingRemoteDesktopViewport: { cols: number; rows: number } | null
  buffering: boolean
  ackPendingOutput: TerminalOutputFrameChunk[]
  ackPendingOutputBytes: number
  ackPendingOutputOverflowed: boolean
  ackRecoverySnapshotInFlight: boolean
  /** A recovery went out screen-only while the link was saturated; history follows once it drains. */
  ackRecoveryHistoryOwed: boolean
  pendingOutput: TerminalOutputChunk[]
  pendingOutputBytes: number
  pendingOutputOverflowed: boolean
  // Cols the mobile client last rewrapped to; re-stream full scrollback only when width actually changes.
  lastResizeCols: number | undefined
  resizeGeneration: number
  outputBatcher: TerminalOutputBatcher
  unsubscribeData: () => void
  unsubscribeResize: () => void
  unsubscribeFit: () => void
  unsubscribeDriver: () => void
  unregisterBinaryHandler: () => void
  // Abort on detach: runtime releases exit-waiters only on real PTY exit, so long-lived agents would leak them.
  exitWaiterAbort: AbortController
}

export type TerminalOutputChunk = {
  data: string
  bytes: number
  meta?: TerminalOutputMeta
}
