import type { TerminalOscLinkRange } from '../../../../../shared/terminal-osc-link-ranges'
import type { TerminalSnapshotUnavailableReason } from '../../../../../shared/terminal-snapshot-unavailability'
import type { TerminalSourceRangeLedger } from '../../terminal-source-range-ledger'
import type { RemoteTerminalSourceRangeReplacementReservation } from '../../../remote-terminal-source-range-consumer'
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
  // Why: distinguishes "I could not answer right now" from a genuinely empty buffer; omitted on success.
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
  ackOutputSourceRanges: boolean
  streamGeneration: string
  sourceRangeLedger: TerminalSourceRangeLedger | null
  sourceRangeConsumerAttached: boolean
  sourceRangeReplacement: RemoteTerminalSourceRangeReplacementReservation | null
  ackInFlightBytes: number
  ackWindowBytes: number
  supportsOutputPause: boolean
  supportsWriteUnavailable: boolean
  outputPaused: boolean
  supportsDesktopViewportClaims: boolean
  desktopClaimTail: Promise<boolean>
  // Whether THIS stream registered the width driver, so detach won't release a peer stream's floor.
  registeredRemoteDesktopDriver: boolean
  remoteDesktopSubscriptionKey: string
  pendingRemoteDesktopViewport: { cols: number; rows: number } | null
  buffering: boolean
  ackPendingOutput: TerminalOutputFrameChunk[]
  ackPendingOutputBytes: number
  ackPendingOutputOverflowed: boolean
  ackRecoverySnapshotInFlight: boolean
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
  // Why: the runtime drops the exit-waiter only on real PTY exit; abort on detach so a never-exiting agent terminal doesn't leak the waiter.
  exitWaiterAbort: AbortController
}

export type TerminalOutputChunk = {
  data: string
  bytes: number
  meta?: TerminalOutputMeta
}
