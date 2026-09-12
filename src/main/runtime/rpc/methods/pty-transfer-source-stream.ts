import { z } from 'zod'
import { defineStreamingMethod } from '../core'
import { PTY_OWNERSHIP_TRANSFER_RUNTIME_METHODS } from '../../../../shared/pty-ownership-transfer-runtime-methods'
import {
  parsePtyOwnershipTransferSourceStreamRequest,
  type PtyOwnershipTransferOutputFrame
} from '../../../../shared/pty-ownership-transfer-wire'
import { PtyOwnershipTransferOutputCreditWindow } from '../../../../shared/pty-ownership-transfer-output-credit'
import { samePtyOwnershipTransferIdentity } from '../../../../shared/pty-ownership-transfer-identity'
import {
  createBinding,
  getSource,
  requirePairedRuntimeClient
} from './pty-transfer-caller-authority'

export const PTY_TRANSFER_SOURCE_STREAM_METHOD = defineStreamingMethod({
  name: PTY_OWNERSHIP_TRANSFER_RUNTIME_METHODS.streamSource,
  params: z.unknown(),
  handler: async (params, context, emit) => {
    requirePairedRuntimeClient(context)
    const request = parsePtyOwnershipTransferSourceStreamRequest(params)
    const source = getSource(context)
    const capabilities = source.getCapabilities()
    if (
      !capabilities.liveTransfer ||
      capabilities.destinationOutput !== true ||
      capabilities.authoritativeExit !== true
    ) {
      throw new Error('pty_ownership_transfer_runtime_source_unavailable')
    }
    const binding = createBinding(context)
    source.assertStreamAuthorized(request, binding)
    const current = source.snapshot(request.bridgeId)
    if (!current || !samePtyOwnershipTransferIdentity(current.identity, request)) {
      throw new Error('pty_ownership_transfer_runtime_source_unavailable')
    }
    const requestedOutputCredit = request.outputCredit
    const canNegotiateOutputCredit =
      requestedOutputCredit !== undefined &&
      typeof source.onDestinationOutputAcknowledgement === 'function'
    const negotiatedOutputCredit = canNegotiateOutputCredit ? requestedOutputCredit : undefined
    const outputCredit = canNegotiateOutputCredit
      ? new PtyOwnershipTransferOutputCreditWindow(
          negotiatedOutputCredit!.windowBytes,
          negotiatedOutputCredit!.windowFrames
        )
      : undefined
    const pendingOutput: PtyOwnershipTransferOutputFrame[] = []
    let pendingOutputBytes = 0
    let streamBroken = false
    const emitLoss = (code: string): void => {
      if (streamBroken) {
        return
      }
      streamBroken = true
      emit({ kind: 'loss', code })
    }
    const flushPendingOutput = (): void => {
      if (!outputCredit || streamBroken) {
        return
      }
      while (pendingOutput.length > 0) {
        const frame = pendingOutput[0]!
        let admission: ReturnType<PtyOwnershipTransferOutputCreditWindow['admit']>
        try {
          admission = outputCredit.admit(frame)
        } catch (error) {
          emitLoss(error instanceof Error ? error.message : 'pty_ownership_transfer_output_loss')
          return
        }
        if (admission === 'capacity') {
          return
        }
        pendingOutput.shift()
        pendingOutputBytes -= Buffer.byteLength(frame.data, 'utf8')
        if (admission === 'accepted') {
          emitOutput(frame)
        }
      }
    }
    const emitOutput = (frame: PtyOwnershipTransferOutputFrame): void => {
      if (!streamBroken) {
        emit({
          kind: 'output',
          identity: current.identity,
          attachmentId: request.attachmentId,
          frame
        })
      }
    }
    const acceptCreditOutput = (frame: PtyOwnershipTransferOutputFrame): void => {
      if (!outputCredit || streamBroken) {
        return
      }
      const frameBytes = Buffer.byteLength(frame.data, 'utf8')
      let classification: ReturnType<PtyOwnershipTransferOutputCreditWindow['classify']>
      try {
        classification = outputCredit.classify(frame)
      } catch (error) {
        emitLoss(error instanceof Error ? error.message : 'pty_ownership_transfer_output_loss')
        return
      }
      if (classification === 'conflict') {
        emitLoss('pty_ownership_transfer_output_credit_frame_conflict')
        return
      }
      if (classification === 'duplicate') {
        return
      }
      const queued = pendingOutput.find((candidate) => candidate.seq === frame.seq)
      if (queued) {
        if (queued.data !== frame.data || queued.truncated !== frame.truncated) {
          emitLoss('pty_ownership_transfer_output_credit_frame_conflict')
        }
        return
      }
      if (pendingOutput.length > 0) {
        const tail = pendingOutput.at(-1)!
        if (frame.seq !== tail.seq + 1) {
          emitLoss('pty_ownership_transfer_output_credit_sequence_gap')
          return
        }
        if (
          pendingOutputBytes + frameBytes > outputCredit.windowBytes ||
          pendingOutput.length >= outputCredit.windowFrames
        ) {
          emitLoss('pty_ownership_transfer_output_credit_queue_overflow')
          return
        }
        pendingOutput.push(frame)
        pendingOutputBytes += frameBytes
        return
      }
      let admission: ReturnType<PtyOwnershipTransferOutputCreditWindow['admit']>
      try {
        admission = outputCredit.admit(frame)
      } catch (error) {
        emitLoss(error instanceof Error ? error.message : 'pty_ownership_transfer_output_loss')
        return
      }
      if (admission === 'accepted') {
        emitOutput(frame)
      } else if (admission === 'capacity') {
        if (frameBytes > outputCredit.windowBytes) {
          emitLoss('pty_ownership_transfer_output_credit_frame_too_large')
          return
        }
        pendingOutput.push(frame)
        pendingOutputBytes = frameBytes
      }
    }
    const disposeAcknowledgement = canNegotiateOutputCredit
      ? source.onDestinationOutputAcknowledgement(
          request,
          request.attachmentId,
          binding,
          (throughSeq) => {
            if (!outputCredit || streamBroken) {
              return
            }
            try {
              outputCredit.acknowledge(throughSeq)
              flushPendingOutput()
            } catch (error) {
              emitLoss(
                error instanceof Error ? error.message : 'pty_ownership_transfer_output_loss'
              )
            }
          }
        )
      : undefined
    const disposeOutput = source.onDestinationOutput((event) => {
      if (
        !streamBroken &&
        event.attachmentId === request.attachmentId &&
        sameIdentity(event.identity, request)
      ) {
        if (outputCredit) {
          acceptCreditOutput(event.frame)
        } else {
          emit({
            kind: 'output',
            identity: event.identity,
            attachmentId: event.attachmentId,
            frame: event.frame
          })
        }
      }
    })
    const disposeExit = source.onDestinationExit((event) => {
      if (event.attachmentId === request.attachmentId && sameIdentity(event, request)) {
        emit({ kind: 'exit', event })
      }
    })
    // The paired caller must not attach or commit until this listener is installed. This
    // readiness frame closes the otherwise unobservable attach/stream race.
    emit({
      kind: 'ready',
      identity: current.identity,
      attachmentId: request.attachmentId,
      ...(outputCredit ? { outputCredit: requestedOutputCredit } : {})
    })
    try {
      await waitForStreamEnd(context.signal)
    } finally {
      disposeOutput()
      disposeExit()
      disposeAcknowledgement?.()
    }
  }
})

function sameIdentity(
  left: {
    bridgeId: string
    terminalId: string
    incarnationId: string
    ownerLease: string
    sourceOwnerGeneration: number
    destinationRuntimeId: string
  },
  right: {
    bridgeId: string
    terminalId: string
    incarnationId: string
    ownerLease: string
    sourceOwnerGeneration: number
    destinationRuntimeId: string
  }
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

function waitForStreamEnd(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.resolve()
  }
  if (!signal) {
    return Promise.reject(new Error('pty_ownership_transfer_stream_signal_required'))
  }
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true })
  })
}
