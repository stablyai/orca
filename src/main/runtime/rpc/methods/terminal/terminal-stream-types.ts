import type { TerminalOscLinkRange } from '../../../../../shared/terminal/links/terminal-osc-link-ranges'
import type { TerminalSnapshotUnavailableReason } from '../../../../../shared/terminal/replay/terminal-snapshot-unavailability'
import type {
  TerminalOutputFrameChunk,
  TerminalOutputMeta
} from '../../terminal-output-frame-chunks'
import type { TerminalOutputBatcher } from './terminal-output-batcher'
import type { TerminalReplyQueryScanState } from '../../../../../shared/terminal/protocol/queries/terminal-reply-query-scan'
import type { YieldedTerminalQuery } from './terminal-multiplex-yielded-queries'

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
  /** The host's tracked title when this image was taken. */
  lastTitle?: string
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
  lastTitle?: string
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
  supportsOutputCadence: boolean
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
  // Output sent before the last recovery image and not yet acknowledged; the next image waits for it so images cannot stack up on a slow link.
  ackRecoveryAwaitedBytes: number
  // Pending headroom granted while paced; kept until the queue drains so leaving alt cannot force an overflow.
  ackPendingHoldbackBytes: number
  // Paced window the last admission used (null when unpaced), so its send records the same decision.
  ackAdmittedPacedWindowBytes: number | null
  // Output outran the window since an ACK last found the queue empty; a recovery clears the queue, not the backlog.
  ackOutputWaited: boolean
  yieldedQueries: YieldedTerminalQuery[]
  yieldedQueryScan: TerminalReplyQueryScanState
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
