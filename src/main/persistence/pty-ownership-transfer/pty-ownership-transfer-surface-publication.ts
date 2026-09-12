import { publicationReceiptMatchesPtyOwnershipTransfer } from '../../../shared/pty-ownership-transfer-receipt-validation'
import {
  parsePtyOwnershipTransferSurfaceBinding,
  samePtyOwnershipTransferSurfaceBinding
} from '../../../shared/pty-ownership-transfer-surface-binding'
import type { PtyOwnershipTransferDestinationPublicationRequest } from '../../../shared/pty-ownership-transfer-destination-adapter'
import type { PtyOwnershipTransferPublicationReceipt } from '../../../shared/pty-ownership-transfer-journal'
import {
  parsePtyOwnershipInitialModelSnapshot,
  type PtyOwnershipInitialModelSnapshot
} from './pty-ownership-transfer-initial-model-snapshot'

export type PtyOwnershipTransferSurfacePublicationRequest =
  PtyOwnershipTransferDestinationPublicationRequest & {
    initialModelSnapshot?: PtyOwnershipInitialModelSnapshot
  }

export type PtyOwnershipTransferSurfacePublicationState = 'absent' | 'published' | 'conflict'

export type PtyOwnershipTransferDurableSurfaceTarget = Readonly<{
  inspectDurablePublication: (
    request: PtyOwnershipTransferSurfacePublicationRequest
  ) => PtyOwnershipTransferSurfacePublicationState
  publishDurably: (request: PtyOwnershipTransferSurfacePublicationRequest) => void
}>

export class PtyOwnershipTransferSurfacePublicationError extends Error {
  constructor(
    readonly reason: 'invalid-request' | 'surface-conflict' | 'publication-unverified',
    message: string
  ) {
    super(message)
    this.name = 'PtyOwnershipTransferSurfacePublicationError'
  }
}

/** Requires host-durable model evidence before releasing the pre-reserved receipt. */
export class PtyOwnershipTransferSurfacePublicationCoordinator {
  constructor(
    private readonly target: PtyOwnershipTransferDurableSurfaceTarget,
    private readonly loadInitialModel?: (
      identity: PtyOwnershipTransferDestinationPublicationRequest['identity']
    ) => PtyOwnershipInitialModelSnapshot | null
  ) {}

  publish(
    value: PtyOwnershipTransferDestinationPublicationRequest
  ): PtyOwnershipTransferPublicationReceipt {
    const initial = this.loadInitialModel?.(value.identity)
    const request: PtyOwnershipTransferSurfacePublicationRequest = {
      identity: value.identity,
      surfaceBinding: value.surfaceBinding,
      publicationReceipt: value.publicationReceipt,
      frames: value.frames,
      ...(initial
        ? {
            initialModelSnapshot: parsePtyOwnershipInitialModelSnapshot(
              initial,
              value.identity,
              value.publicationReceipt.commitReceipt.acceptedSourceEndSeq
            )
          }
        : {})
    }
    validatePublicationRequest(request)
    const before = this.target.inspectDurablePublication(request)
    if (before === 'conflict') {
      throw new PtyOwnershipTransferSurfacePublicationError(
        'surface-conflict',
        'terminal surface is occupied by another durable binding'
      )
    }
    if (before === 'absent') {
      this.target.publishDurably(request)
    }
    if (this.target.inspectDurablePublication(request) !== 'published') {
      throw new PtyOwnershipTransferSurfacePublicationError(
        'publication-unverified',
        'terminal surface publication is not durably observable'
      )
    }
    return structuredClone(request.publicationReceipt)
  }
}

function validatePublicationRequest(request: PtyOwnershipTransferSurfacePublicationRequest): void {
  let surfaceBinding
  try {
    surfaceBinding = parsePtyOwnershipTransferSurfaceBinding(request.surfaceBinding)
  } catch {
    throw invalidPublicationRequest()
  }
  if (
    !publicationReceiptMatchesPtyOwnershipTransfer(
      request.publicationReceipt,
      request.identity,
      request.publicationReceipt.commitReceipt
    ) ||
    !samePtyOwnershipTransferSurfaceBinding(
      request.publicationReceipt.surfaceBinding,
      surfaceBinding
    ) ||
    !framesReachCommit(request)
  ) {
    throw invalidPublicationRequest()
  }
}

function framesReachCommit(request: PtyOwnershipTransferSurfacePublicationRequest): boolean {
  const acceptedEnd = request.publicationReceipt.commitReceipt.acceptedSourceEndSeq
  if (request.initialModelSnapshot) {
    // The seed represents the exact commit boundary; replay would apply those bytes twice.
    return request.frames.length === 0 && request.initialModelSnapshot.throughSeq === acceptedEnd
  }
  if (request.frames.length === 0) {
    return acceptedEnd === 0
  }
  let previous = 0
  for (const frame of request.frames) {
    if (
      !Number.isSafeInteger(frame.seq) ||
      frame.seq < 0 ||
      frame.seq !== previous + 1 ||
      typeof frame.data !== 'string' ||
      frame.data.length === 0 ||
      frame.truncated === true
    ) {
      return false
    }
    previous = frame.seq
  }
  return previous === acceptedEnd
}

function invalidPublicationRequest(): PtyOwnershipTransferSurfacePublicationError {
  return new PtyOwnershipTransferSurfacePublicationError(
    'invalid-request',
    'surface publication request does not prove the exact committed transfer'
  )
}
