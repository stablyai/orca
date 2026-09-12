import type { PtyOwnershipTransferExit } from '../shared/pty-ownership-transfer-control-wire'
import type { PtyOwnershipCaptureBaseline } from '../shared/pty-ownership-capture-baseline'
import type { PtyOwnershipCaptureBoundary } from '../shared/pty-ownership-capture-boundary'
import type { RelayPtyOwnershipTransferDestinationOutputRoute } from './relay-pty-ownership-transfer-destination-output-route'
import type { PtyOwnershipTransferDestinationDelegation } from '../shared/pty-ownership-transfer-destination-delegation'
import type { PtyOwnershipTransferDestinationClaim } from '../shared/pty-ownership-transfer-destination-claim'
import type {
  PtyOwnershipTransferCommitReceipt,
  PtyOwnershipTransferPublicationReceipt
} from '../shared/pty-ownership-transfer-journal-contract'
import type {
  PtyOwnershipTransferOutputFrame,
  PtyOwnershipTransferSurfacePublication,
  PtyOwnershipTransferWireIdentity
} from '../shared/pty-ownership-transfer-wire'
import type { PtyOwnershipTransferOutputFragment } from '../shared/pty-ownership-transfer-output-envelope'
import type {
  RelayPtyOwnershipTransferAdapterOptions,
  RelayPtyOwnershipTransferControlRecord
} from './relay-pty-ownership-transfer-adapter-contract'
import { RelayPtyOwnershipTransferError } from './relay-pty-ownership-transfer-errors'
import { restoreRelayPtyOwnershipTransferState } from './relay-pty-ownership-transfer-adapter-persistence'
import { boundedTransferPositive } from './relay-pty-ownership-transfer-adapter-validation'
import type { RelayPtySourceRetirement } from './relay-pty-source-retirement-journal'
import type { RelayPtyCoveredSourceRetirement } from './relay-pty-covered-source-retirement-journal'
import type { RelayPtyRawEmissionCheckpoint } from './relay-pty-raw-emission-checkpoint'
import type { RelayPtyRawCaptureAnchor } from './relay-pty-raw-capture-anchor'

export type RelayPtyOwnershipTransferOutputHistory = {
  nextSeq: number
  retainedBytes: number
  frames: PtyOwnershipTransferOutputFrame[]
}

export const RELAY_PTY_OWNERSHIP_TRANSFER_RETRY_MEMO_MAX = 16

export type RelayPtyOwnershipTransferEmissionMemo = {
  key: string
  data: string
  frames: readonly PtyOwnershipTransferOutputFrame[]
  fragments: readonly PtyOwnershipTransferOutputFragment[]
}

export type RelayPtyOwnershipTransferRecord = {
  committedSourceOutputEndSeq?: number
  rawEmissionCheckpoint?: RelayPtyRawEmissionCheckpoint
  rawCaptureAnchors?: readonly RelayPtyRawCaptureAnchor[]
  sourceDeliveryRetirement?: RelayPtySourceRetirement
  coveredSourceDeliveryRetirement?: RelayPtyCoveredSourceRetirement
  issuedCaptureBoundaries?: readonly PtyOwnershipCaptureBoundary[]
  captureBaseline?: PtyOwnershipCaptureBaseline
  identity: PtyOwnershipTransferWireIdentity
  destinationDelegation?: PtyOwnershipTransferDestinationDelegation
  destinationClaim?: PtyOwnershipTransferDestinationClaim
  destinationClaimBinding?: Readonly<{
    clientId: number
    transportGeneration: number
    principal: string
  }>
  destinationDelegationWriteUnverifiable?: boolean
  destinationOutputRetention?: true
  destinationInputJournal?: true
  destinationControlJournal?: true
  destinationControls?: Map<string, RelayPtyOwnershipTransferControlRecord>
  destinationInputEpoch?: number
  destinationInputs?: Map<string, { data: string; outcome: 'applied' | 'unverifiable' }>
  destinationAcknowledgedSeq?: number
  destinationDeliveredSeq?: number
  destinationOutputRoute?: RelayPtyOwnershipTransferDestinationOutputRoute
  phase: 'prepared' | 'committed' | 'published' | 'aborted'
  sourceOutputEndSeq: number
  replayStartSeq: number
  surfacePublication?: PtyOwnershipTransferSurfacePublication
  commitReceipt?: PtyOwnershipTransferCommitReceipt
  publicationReceipt?: PtyOwnershipTransferPublicationReceipt
  acceptedInputIds: Map<string, string>
  acceptedControls: Map<string, RelayPtyOwnershipTransferControlRecord>
  /** Durable route fence; the active socket binding is restored only by attach/rekey. */
  reconnectRoute?: Readonly<{
    generation: number
    attachmentId: string
  }>
  attachmentId?: string
  /** Ephemeral relay-client binding; never persisted and invalidated on socket rotation. */
  attachmentBinding?: Readonly<{
    clientId: number
    transportGeneration?: number
  }>
  exit?: PtyOwnershipTransferExit
  exitObservationPending?: boolean
  /** Bounded in-memory retry memos prevent overlapping failed emissions from minting new sequences. */
  readonly observedEmissions: Map<string, RelayPtyOwnershipTransferEmissionMemo>
}

export type RelayPtyOwnershipTransferAttachmentBinding = Readonly<{
  clientId: number
  transportGeneration?: number
}>

export type RelayPtyOwnershipTransferAdapterState = {
  wakeDestinationOutput?: () => void
  readonly options: RelayPtyOwnershipTransferAdapterOptions
  readonly replayBytes: number
  readonly inputIds: number
  readonly histories: Map<string, RelayPtyOwnershipTransferOutputHistory>
  readonly transfers: Map<string, RelayPtyOwnershipTransferRecord>
  readonly transferByTerminal: Map<string, string>
}

export function newRelayPtyOwnershipTransferAdapterState(args: {
  options: RelayPtyOwnershipTransferAdapterOptions
  replayBytes?: number
  inputIds?: number
}): RelayPtyOwnershipTransferAdapterState {
  const state: RelayPtyOwnershipTransferAdapterState = {
    options: args.options,
    replayBytes:
      args.replayBytes ??
      boundedTransferPositive(args.options.replayBytes ?? 128 * 1024, 4 * 1024 * 1024),
    inputIds: args.inputIds ?? boundedTransferPositive(args.options.inputIds ?? 4_096, 65_536),
    histories: new Map(),
    transfers: new Map(),
    transferByTerminal: new Map()
  }
  restoreRelayPtyOwnershipTransferState(state)
  return state
}

export function emptyRelayPtyOwnershipTransferHistory(): RelayPtyOwnershipTransferOutputHistory {
  return { nextSeq: 1, retainedBytes: 0, frames: [] }
}

export function relayPtyOwnershipTransferExecutionVerdict(
  state: RelayPtyOwnershipTransferAdapterState,
  transfer: RelayPtyOwnershipTransferRecord
): 'live' | 'unverifiable' | 'exited' {
  if (transfer.exit) {
    return transfer.destinationDelegation && transfer.exitObservationPending
      ? 'unverifiable'
      : 'exited'
  }
  if (transfer.destinationDelegation) {
    try {
      return state.options.resolveTerminalIncarnation?.(transfer.identity.terminalId) ===
        transfer.identity.incarnationId
        ? 'live'
        : 'unverifiable'
    } catch {
      return 'unverifiable'
    }
  }
  const source = state.options.resolveSource(transfer.identity.terminalId)
  return source?.incarnationId === transfer.identity.incarnationId ? 'live' : 'unverifiable'
}

export function requireRelayPtyOwnershipTransfer(
  state: RelayPtyOwnershipTransferAdapterState,
  request: PtyOwnershipTransferWireIdentity
): RelayPtyOwnershipTransferRecord {
  const transfer = state.transfers.get(request.bridgeId)
  if (!transfer) {
    throw new RelayPtyOwnershipTransferError(
      'not-found',
      'ownership transfer bridge is not known by this relay'
    )
  }
  assertRelayPtyOwnershipTransferIdentity(transfer, request)
  return transfer
}

export function assertRelayPtyOwnershipTransferIdentity(
  transfer: RelayPtyOwnershipTransferRecord,
  request: PtyOwnershipTransferWireIdentity
): void {
  const expected = transfer.identity
  if (
    expected.bridgeId !== request.bridgeId ||
    expected.terminalId !== request.terminalId ||
    expected.incarnationId !== request.incarnationId ||
    expected.ownerLease !== request.ownerLease ||
    expected.sourceOwnerGeneration !== request.sourceOwnerGeneration ||
    expected.destinationRuntimeId !== request.destinationRuntimeId
  ) {
    throw new RelayPtyOwnershipTransferError(
      'identity-mismatch',
      'ownership transfer request does not match its prepared source'
    )
  }
}
