import type { PtyOwnershipTransferOutputEnvelope } from '../../shared/pty-ownership-transfer-output-envelope'
import {
  PtyOwnershipTransferDestinationRuntimeRegistry,
  type PtyOwnershipTransferDestinationRuntimeOptions
} from '../persistence/pty-ownership-transfer/pty-ownership-transfer-destination-runtime'
import type { PtyOwnershipTransferWireIdentity } from '../../shared/pty-ownership-transfer-wire'
import type { PtyOwnershipTransferSurfaceBinding } from '../../shared/pty-ownership-transfer-surface-binding'
import type { RuntimeStore } from './runtime-store-contract'
import type { RuntimeTerminalPromptDelivery } from '../../shared/runtime-terminal-contracts'
import type { PtyOwnershipTransferDestinationClaim } from '../../shared/pty-ownership-transfer-destination-claim'
import type { PtyOwnershipTransferPublicationReceipt } from '../../shared/pty-ownership-transfer-journal'
import type { OrcadTerminalLayoutAdmission } from '../persistence/migrating-orcad-catalog/orcad-terminal-layout-admission'
import type { parsePtyOwnershipTransferSourceRetirementEvidence } from '../../shared/pty-ownership-transfer-source-retirement'
export type RuntimeCapturedSourceRetirementRequest = {
  recoveryOnly?: boolean
  identity: PtyOwnershipTransferWireIdentity
  retirementRecordSha256: string
  expectedDelivery: unknown
  signal: AbortSignal
  assertAuthority: () => void
  assertActivation?: (activation: {
    identity: PtyOwnershipTransferWireIdentity
    publicationReceipt: PtyOwnershipTransferPublicationReceipt
    catalogAdmission: OrcadTerminalLayoutAdmission
    destinationClaim: PtyOwnershipTransferDestinationClaim
  }) => void
}
export type RuntimeCapturedPtyDestinationLifecycle = {
  inspectPublishedDestinationOutputCoverage?: (
    identity: PtyOwnershipTransferWireIdentity,
    throughSeq: number,
    signal: AbortSignal
  ) => Promise<{
    identity: PtyOwnershipTransferWireIdentity
    destinationClaim: PtyOwnershipTransferDestinationClaim
    publicationReceipt: PtyOwnershipTransferPublicationReceipt
    catalogAdmission: OrcadTerminalLayoutAdmission
    coverage: {
      throughSeq: number
      acknowledgedEndSeq: number
      modelThroughSeq: number
      modelSequenceEnd: number
    }
  }>
  supportsCapturedSourceRetirementRecovery?: () => boolean
  retirePublishedSourceDelivery?: (
    request: RuntimeCapturedSourceRetirementRequest
  ) => Promise<ReturnType<typeof parsePtyOwnershipTransferSourceRetirementEvidence>>
  supportsCapturedCatalogPublication?: () => boolean
  inspectPublishedDestinationActivation?: (
    identity: PtyOwnershipTransferWireIdentity,
    signal: AbortSignal
  ) => Promise<{
    identity: PtyOwnershipTransferWireIdentity
    destinationClaim: PtyOwnershipTransferDestinationClaim
    publicationReceipt: PtyOwnershipTransferPublicationReceipt
    catalogAdmission: OrcadTerminalLayoutAdmission
  }>
  prepareCapturedDestination: PtyOwnershipTransferDestinationRuntimeRegistry['prepareCapturedDelegated']
}

export type RuntimePtyOwnershipTransferModelCheckpoint = Readonly<{
  ptyId: string
  ptyIncarnation: string
  modelSequenceEnd: number
  projectionSequenceEnd: number
  ownershipTransfer: PtyOwnershipTransferOutputEnvelope
  /** Exact fragment bytes admitted to the authoritative model. */
  data: string
}>

export type PtyOwnershipTransferModelCheckpointFragment = Readonly<{
  identity: PtyOwnershipTransferWireIdentity
  surfaceBinding: PtyOwnershipTransferSurfaceBinding
  ptyId: string
  frameSeq: number
  fragmentStartSu: number
  fragmentEndSu: number
  frameLengthSu: number
  data: string
  modelSequenceEnd: number
}>

export type PtyOwnershipTransferModelCheckpointFrame = {
  identity: PtyOwnershipTransferWireIdentity
  surfaceBinding: PtyOwnershipTransferSurfaceBinding
  ptyId: string
  frameLengthSu: number
  fragments: Map<number, PtyOwnershipTransferModelCheckpointFragment>
}

export type TerminalSendOperationResult = {
  bytesWritten: number
  prompt?: RuntimeTerminalPromptDelivery
}

export type TerminalSendOperationRecord = Readonly<
  TerminalSendOperationResult & {
    incarnationId: string
    payloadFingerprint: string
    expiresAt: number
  }
>

export type TerminalSendOperationInFlight = Readonly<{
  incarnationId: string
  payloadFingerprint: string
  promise: Promise<TerminalSendOperationResult>
}>

export const TERMINAL_SEND_OPERATION_TTL_MS = 15 * 60_000

export const TERMINAL_SEND_OPERATION_MAX_PER_PTY = 256

export function createPtyOwnershipTransferDestinationRegistry(
  store: RuntimeStore | null,
  runtimeId: string,
  publishPostCommitOutput:
    | PtyOwnershipTransferDestinationRuntimeOptions['publishPostCommitOutput']
    | undefined,
  publishPostCommitOutputAcknowledged?: PtyOwnershipTransferDestinationRuntimeOptions['publishPostCommitOutputAcknowledged'],
  catalogPublicationVersion?: 1
): PtyOwnershipTransferDestinationRuntimeRegistry | null {
  if (
    !store ||
    !publishPostCommitOutput ||
    !publishPostCommitOutputAcknowledged ||
    typeof store.getProfileStorageDirectory !== 'function' ||
    typeof store.inspectPtyOwnershipTransferSurface !== 'function' ||
    typeof store.publishPtyOwnershipTransferSurface !== 'function'
  ) {
    return null
  }
  try {
    return new PtyOwnershipTransferDestinationRuntimeRegistry({
      runtimeId,
      store: store as PtyOwnershipTransferDestinationRuntimeOptions['store'],
      publishPostCommitOutput,
      publishPostCommitOutputAcknowledged,
      catalogPublicationVersion
    })
  } catch {
    // A bad optional transfer sink must not prevent runtime startup.
    return null
  }
}

export function samePtyOwnershipTransferIdentity(
  left: PtyOwnershipTransferWireIdentity,
  right: PtyOwnershipTransferWireIdentity
): boolean {
  return (
    left.bridgeId === right.bridgeId &&
    left.terminalId === right.terminalId &&
    left.incarnationId === right.incarnationId &&
    left.ownerLease === right.ownerLease &&
    left.sourceOwnerGeneration === right.sourceOwnerGeneration &&
    left.destinationRuntimeId === right.destinationRuntimeId
  )
}

export function operationIdForChunk(operationId: string, index: number): string {
  return index === 0 ? operationId : `${operationId}:chunk:${index}`
}
