import type { PtyOwnershipBridgeCapabilities } from '../../../shared/pty-ownership-bridge-contract'
import type { PtyOwnershipTransferDestinationAdapter } from '../../../shared/pty-ownership-transfer-destination-adapter'
import type {
  PtyOwnershipTransferCommitReceipt,
  PtyOwnershipTransferPublicationReceipt,
  PtyOwnershipTransferIdentity
} from '../../../shared/pty-ownership-transfer-journal-contract'
import type { PtyOwnershipTransferSurfaceBinding } from '../../../shared/pty-ownership-transfer-surface-binding'
import type {
  PtyOwnershipTransferAbortRequest,
  PtyOwnershipTransferAbortResult,
  PtyOwnershipTransferAttachmentRequest,
  PtyOwnershipTransferAttachmentResult,
  PtyOwnershipTransferCommitRequest,
  PtyOwnershipTransferCommitResult,
  PtyOwnershipTransferPrepareRequest,
  PtyOwnershipTransferPrepareResult,
  PtyOwnershipTransferPublishRequest,
  PtyOwnershipTransferPublishResult,
  PtyOwnershipTransferReplayRequest,
  PtyOwnershipTransferReplayResult,
  PtyOwnershipTransferStatusRequest,
  PtyOwnershipTransferStatusResult
} from '../../../shared/pty-ownership-transfer-wire'
import type { PtyOwnershipTransferExitEvent } from '../../../shared/pty-ownership-transfer-control-wire'
import type {
  PtyOwnershipTransferOutputFrame,
  PtyOwnershipTransferWireIdentity
} from '../../../shared/pty-ownership-transfer-wire'
import type {
  PtyOwnershipTransferReconnectRekeyRequest,
  PtyOwnershipTransferReconnectRekeyResult
} from '../../../shared/pty-ownership-transfer-reconnect-rekey-wire'
import type { PtyOwnershipTransferRequestOptions } from '../../providers/ssh-pty-ownership-transfer-client'
import type { PtyOwnershipTransferDestinationRuntimeRegistry } from './pty-ownership-transfer-destination-runtime'

export type PtyOwnershipTransferSource = Readonly<{
  prepare: (
    request: PtyOwnershipTransferPrepareRequest,
    options?: PtyOwnershipTransferRequestOptions
  ) => Promise<PtyOwnershipTransferPrepareResult>
  replay: (
    request: PtyOwnershipTransferReplayRequest,
    options?: PtyOwnershipTransferRequestOptions
  ) => Promise<PtyOwnershipTransferReplayResult>
  commit: (
    request: PtyOwnershipTransferCommitRequest,
    options?: PtyOwnershipTransferRequestOptions
  ) => Promise<PtyOwnershipTransferCommitResult>
  publish: (
    request: PtyOwnershipTransferPublishRequest,
    options?: PtyOwnershipTransferRequestOptions
  ) => Promise<PtyOwnershipTransferPublishResult>
  abort: (
    request: PtyOwnershipTransferAbortRequest,
    options?: PtyOwnershipTransferRequestOptions
  ) => Promise<PtyOwnershipTransferAbortResult>
  status?: (
    request: PtyOwnershipTransferStatusRequest,
    options?: PtyOwnershipTransferRequestOptions
  ) => Promise<PtyOwnershipTransferStatusResult>
  /** Optional capability-negotiated destination attachment for live output routing. */
  attachDestination?: (
    request: PtyOwnershipTransferAttachmentRequest,
    capabilities: PtyOwnershipBridgeCapabilities,
    options?: PtyOwnershipTransferRequestOptions
  ) => Promise<PtyOwnershipTransferAttachmentResult>
  /** Optional capability-negotiated atomic route advance after source-owner reconnect. */
  rekeyReconnect?: (
    request: PtyOwnershipTransferReconnectRekeyRequest,
    capabilities: PtyOwnershipBridgeCapabilities,
    options?: PtyOwnershipTransferRequestOptions
  ) => Promise<PtyOwnershipTransferReconnectRekeyResult>
  /** Optional authoritative exit notification stream for a committed destination attachment. */
  onDestinationExit?: (
    capabilities: PtyOwnershipBridgeCapabilities,
    callback: (event: PtyOwnershipTransferExitEvent) => void
  ) => () => void
  /** Attachment-scoped exit stream used by paired-runtime transports. */
  onDestinationExitForAttachment?: (
    capabilities: PtyOwnershipBridgeCapabilities,
    identity: PtyOwnershipTransferWireIdentity,
    attachmentId: string,
    callback: (event: PtyOwnershipTransferExitEvent) => void
  ) => () => void
  /** Optional paired-runtime stream for post-commit output. */
  onDestinationOutput?: (
    capabilities: PtyOwnershipBridgeCapabilities,
    identity: PtyOwnershipTransferWireIdentity,
    attachmentId: string,
    callback: (event: {
      identity: PtyOwnershipTransferWireIdentity
      attachmentId: string
      frame: PtyOwnershipTransferOutputFrame
    }) => void | Promise<void>
  ) => () => void
  /** Resolves only after a paired source stream has installed its listener. */
  waitForDestinationStreamReady?: (
    capabilities: PtyOwnershipBridgeCapabilities,
    identity: PtyOwnershipTransferWireIdentity,
    attachmentId: string
  ) => Promise<void>
  /** Marks the destination unverifiable when the authoritative source stream is lost. */
  onDestinationTransportLost?: (
    capabilities: PtyOwnershipBridgeCapabilities,
    identity: PtyOwnershipTransferWireIdentity,
    attachmentId: string,
    callback: () => void
  ) => () => void
}>

export type PtyOwnershipTransferCoordinatorOptions = Readonly<{
  source: PtyOwnershipTransferSource
  destination: PtyOwnershipTransferDestinationRuntimeRegistry
  identity: PtyOwnershipTransferIdentity
  surfaceBinding: PtyOwnershipTransferSurfaceBinding
  signal?: AbortSignal
  timeoutMs?: number
  maxReplayPasses?: number
  now?: () => Date
  createReceiptId?: () => string
  destinationCapabilities?: PtyOwnershipBridgeCapabilities | null
  getDestinationCapabilities?: (
    options?: PtyOwnershipTransferRequestOptions
  ) => Promise<PtyOwnershipBridgeCapabilities | null>
  createAttachmentId?: () => string
  /** Current authenticated source-owner generation, resolved only during reconnect recovery. */
  getReconnectGeneration?: (
    options?: PtyOwnershipTransferRequestOptions
  ) => number | Promise<number>
}>

export type PtyOwnershipTransferCoordinatorResult = Readonly<{
  identity: PtyOwnershipTransferIdentity
  commitReceipt: PtyOwnershipTransferCommitReceipt
  publicationReceipt: PtyOwnershipTransferPublicationReceipt
  destination: PtyOwnershipTransferDestinationAdapter
}>

export type PtyOwnershipTransferRecoveryResult = Readonly<{
  source: PtyOwnershipTransferStatusResult
  destination: PtyOwnershipTransferDestinationAdapter | null
  /** True when source and destination have converged on published ownership. */
  published: boolean
}>
