import type {
  PtyOwnershipTransferControl,
  PtyOwnershipTransferControlResult,
  PtyOwnershipTransferExit,
  PtyOwnershipTransferExitEvent,
  PtyOwnershipTransferOutputFrame,
  PtyOwnershipTransferSurfacePublication,
  PtyOwnershipTransferWireIdentity
} from '../shared/pty-ownership-transfer-wire'
import type { PtyOwnershipCaptureBaseline } from '../shared/pty-ownership-capture-baseline'
import type { PtyOwnershipCaptureBoundary } from '../shared/pty-ownership-capture-boundary'
import type { PtySourceDeliverySnapshot } from '../shared/pty-source-credit-contract'
import type {
  PtyOwnershipTransferCommitReceipt,
  PtyOwnershipTransferPublicationReceipt
} from '../shared/pty-ownership-transfer-journal-contract'
import type { RequestContext } from './dispatcher'
import type { HostProcessInspection } from '../shared/terminal-process-inspection'
import type { PtyOwnershipTransferDestinationDelegation } from '../shared/pty-ownership-transfer-destination-delegation'
import type { PtyOwnershipTransferDestinationClaim } from '../shared/pty-ownership-transfer-destination-claim'
import type { PtyOwnershipTransferTerminalInfo } from '../shared/pty-ownership-transfer-terminal-info'
import type { RelayPtySourceRetirement } from './relay-pty-source-retirement-journal'
import type { RelayPtyCoveredSourceRetirement } from './relay-pty-covered-source-retirement-journal'
import type { prepareRelayPtySourceDeliveryRetirement } from './relay-pty-source-delivery-retirement'
import type { RelayPtyRawEmissionCheckpoint } from './relay-pty-raw-emission-checkpoint'
import type { RelayPtyRawCaptureAnchor } from './relay-pty-raw-capture-anchor'
import type { retireRelayPtySuccessorSourceDelivery } from './relay-pty-successor-retirement-ingress'

export type RelayPtyOwnershipTransferSource = Readonly<{
  terminalId: string
  incarnationId: string
  ownerLease: string
  sourceOwnerGeneration: number
}>

export type RelayPtyOwnershipTransferDurableRecord = Readonly<{
  committedSourceOutputEndSeq?: number
  rawEmissionCheckpoint?: RelayPtyRawEmissionCheckpoint
  rawCaptureAnchors?: readonly RelayPtyRawCaptureAnchor[]
  version: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12
  coveredSourceDeliveryRetirement?: RelayPtyCoveredSourceRetirement
  retirementJournalVersion?: 5 | 6 | 7 | 8 | 9 | 10
  sourceDeliveryRetirement?: RelayPtySourceRetirement
  issuedCaptureBoundaries?: readonly PtyOwnershipCaptureBoundary[]
  captureJournalVersion?: 4 | 5 | 6 | 7 | 8
  captureBaseline?: PtyOwnershipCaptureBaseline
  destinationControlJournal?: true
  destinationControls?: readonly Readonly<{
    controlId: string
    serializedControl: string
    outcome: 'applied' | 'unverifiable'
  }>[]
  destinationOutputRetention?: true
  destinationInputJournal?: true
  destinationInputEpoch?: number
  destinationInputs?: readonly Readonly<{
    inputId: string
    data: string
    outcome: 'applied' | 'unverifiable'
  }>[]
  identity: PtyOwnershipTransferWireIdentity
  destinationDelegation?: PtyOwnershipTransferDestinationDelegation
  destinationClaim?: PtyOwnershipTransferDestinationClaim
  phase: 'prepared' | 'committed' | 'published' | 'aborted'
  sourceOutputEndSeq: number
  replayStartSeq: number
  history: Readonly<{
    nextSeq: number
    frames: readonly PtyOwnershipTransferOutputFrame[]
  }>
  /** Bounded retry identity retained so a relay restart can replay a failed publication safely. */
  observedEmissions?: readonly Readonly<{
    key: string
    data: string
    frames: readonly PtyOwnershipTransferOutputFrame[]
  }>[]
  acceptedInputs: readonly Readonly<{ inputId: string; data: string }>[]
  acceptedControls: readonly Readonly<{
    controlId: string
    serializedControl: string
    outcome: PtyOwnershipTransferControlResult['outcome']
  }>[]
  /** Stable across relay restart; the socket/client binding remains intentionally ephemeral. */
  reconnectRoute?: Readonly<{
    generation: number
    attachmentId: string
  }>
  exit?: PtyOwnershipTransferExit
  surfacePublication?: PtyOwnershipTransferSurfacePublication
  commitReceipt?: PtyOwnershipTransferCommitReceipt
  publicationReceipt?: PtyOwnershipTransferPublicationReceipt
}>

export type RelayPtyOwnershipTransferStore = Readonly<{
  loadAll: () => readonly RelayPtyOwnershipTransferDurableRecord[]
  save: (record: RelayPtyOwnershipTransferDurableRecord) => void
  remove: (bridgeId: string) => void
}>

export type RelayPtyOwnershipTransferAdapterOptions = Readonly<{
  successorRetirementDependencies?: Parameters<typeof retireRelayPtySuccessorSourceDelivery>[7]
  replayBytes?: number
  inputIds?: number
  /** Optional crash-safe source journal. Mutations remain dormant unless the caller registers them. */
  store?: RelayPtyOwnershipTransferStore
  /** Preparation-only implementation gate; claim/output/recovery are not promoted yet. */
  enableDestinationDelegationPreparation?: boolean
  /** Claim-only implementation gate; no production caller enables it. */
  enableDestinationDelegationClaims?: boolean
  /** Dormant ACK-aware retention; no production caller enables it. */
  enableDestinationOutputRetention?: boolean
  enableCaptureImportAcknowledgement?: boolean
  enableDestinationOutputRoutes?: boolean
  /** Dormant delegated commit; requires retention, claims and an active output route. */
  enableDestinationDelegationCommit?: boolean
  enableSourceDeliveryRetirement?: boolean
  prepareSourceDeliveryRetirement?: (
    identity: PtyOwnershipTransferWireIdentity,
    expectedDelivery?: PtySourceDeliverySnapshot
  ) => ReturnType<typeof prepareRelayPtySourceDeliveryRetirement>
  enableDestinationDelegationInput?: boolean
  enableDestinationDelegationControl?: boolean
  resolveSource: (terminalId: string) => RelayPtyOwnershipTransferSource | null
  /** Host-owned incarnation lookup; does not grant source-owner or destination authority. */
  resolveTerminalIncarnation?: (terminalId: string) => string | null
  inspectDestinationTerminal?: (
    identity: PtyOwnershipTransferWireIdentity
  ) => PtyOwnershipTransferTerminalInfo | undefined
  inspectDestinationCwd?: (
    identity: PtyOwnershipTransferWireIdentity,
    isAuthorized: () => boolean
  ) => Promise<string | null>
  inspectDestinationProcess?: (
    identity: PtyOwnershipTransferWireIdentity,
    isAuthorized: () => boolean
  ) => Promise<HostProcessInspection>
  /** Host ingress may retain output not yet represented by the journal cursor. */
  hasPendingSourceOutput?: (terminalId: string) => boolean
  /** Authorizes the requesting owner before any transfer RPC mutates relay state. */
  authorizeRequest: (
    method: string,
    request: unknown,
    context: RequestContext
  ) => boolean | Promise<boolean>
  /** Fences source-side input. Output remains live and is captured by observeOutput(). */
  setInputFenced: (terminalId: string, fenced: boolean) => void
  /** Destination input is written only after a commit receipt has been accepted. */
  writeDestinationInput: (terminalId: string, data: string) => void
  /** Publishes output generated after commit through the existing source-credit transport. */
  publishDestinationOutput: (
    identity: PtyOwnershipTransferWireIdentity,
    attachmentId: string,
    frame: PtyOwnershipTransferOutputFrame
  ) => void
  applyDestinationControl?: (
    identity: PtyOwnershipTransferWireIdentity,
    control: PtyOwnershipTransferControl,
    isAuthorized?: () => boolean
  ) => 'applied' | 'unverifiable' | Promise<'applied' | 'unverifiable'>
  /** Publishes exit only to the relay client/generation that owns the attachment. */
  publishDestinationExit?: (
    event: PtyOwnershipTransferExitEvent,
    binding?: Readonly<{ clientId: number; transportGeneration?: number }>
  ) => void
  createExitEventId?: () => string
  now?: () => Date
  onCommitted?: (identity: PtyOwnershipTransferWireIdentity) => void
  onPublished?: (identity: PtyOwnershipTransferWireIdentity) => void
  onAborted?: (identity: PtyOwnershipTransferWireIdentity) => void
}>

export type RelayPtyOwnershipTransferControlRecord = Readonly<{
  serializedControl: string
  outcome: PtyOwnershipTransferControlResult['outcome']
}>
