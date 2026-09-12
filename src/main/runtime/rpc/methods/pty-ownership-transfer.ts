import { PTY_TRANSFER_SOURCE_STREAM_METHOD } from './pty-transfer-source-stream'
import {
  createBinding,
  getSource,
  requirePairedRuntimeClient
} from './pty-transfer-caller-authority'
import { z } from 'zod'
import { PTY_OWNERSHIP_TRANSFER_RUNTIME_METHODS } from '../../../../shared/pty-ownership-transfer-runtime-methods'
import {
  parsePtyOwnershipTransferAbortRequest,
  parsePtyOwnershipTransferCommitRequest,
  parsePtyOwnershipTransferInputRequest,
  parsePtyOwnershipTransferPrepareRequest,
  parsePtyOwnershipTransferPublishRequest,
  parsePtyOwnershipTransferReplayRequest,
  parsePtyOwnershipTransferRetireInputRequest,
  parsePtyOwnershipTransferOutputAcknowledgementRequest
} from '../../../../shared/pty-ownership-transfer-wire'
import {
  parsePtyOwnershipTransferAttachmentRequest,
  parsePtyOwnershipTransferControlRequest
} from '../../../../shared/pty-ownership-transfer-control-wire'
import { parsePtyOwnershipTransferReconnectRekeyRequest } from '../../../../shared/pty-ownership-transfer-reconnect-rekey-wire'
import type { RuntimePtyOwnershipTransferSourceAdapter } from '../../../providers/runtime-pty-ownership-transfer-source-adapter'
import { defineMethod, type RpcMethod } from '../core'
import { parsePtyOwnershipTransferSourceGrantRequest } from '../../../../shared/pty-ownership-transfer-source-grant'

const RuntimeOwnedPtyPreflight = z.object({
  ptyId: z.string().min(1),
  destinationRuntimeId: z.string().min(1)
})

const PtyOwnershipTransferIdentity = z.object({
  bridgeId: z.string().min(1),
  terminalId: z.string().min(1),
  incarnationId: z.string().min(1),
  ownerLease: z.string().min(1),
  sourceOwnerGeneration: z.number().int().positive(),
  destinationRuntimeId: z.string().min(1)
})

const RuntimeOwnedPtyStatus = RuntimeOwnedPtyPreflight.extend({
  identity: PtyOwnershipTransferIdentity,
  timeoutMs: z.number().int().positive().optional()
})

const RuntimeOwnedPtyMutation = z.unknown()

export const PTY_OWNERSHIP_TRANSFER_METHODS = [
  defineMethod({
    name: PTY_OWNERSHIP_TRANSFER_RUNTIME_METHODS.preflightSource,
    params: RuntimeOwnedPtyPreflight,
    handler: (params, context) => {
      requirePairedRuntimeClient(context)
      return context.runtime.preflightPtyOwnershipTransfer({
        connectionId: null,
        ptyId: params.ptyId,
        destinationRuntimeId: params.destinationRuntimeId
      })
    }
  }),
  defineMethod({
    name: PTY_OWNERSHIP_TRANSFER_RUNTIME_METHODS.statusSource,
    params: RuntimeOwnedPtyStatus,
    handler: (params, context) => {
      requirePairedRuntimeClient(context)
      return context.runtime.getPtyOwnershipTransferStatus({
        connectionId: null,
        ptyId: params.ptyId,
        destinationRuntimeId: params.destinationRuntimeId,
        identity: params.identity,
        ...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs })
      })
    }
  }),
  defineMethod({
    name: PTY_OWNERSHIP_TRANSFER_RUNTIME_METHODS.grantSource,
    params: z.unknown(),
    handler: (params, context) => {
      requirePairedRuntimeClient(context)
      return context.runtime.issuePairedRuntimePtyOwnershipTransferSourceGrant(
        parsePtyOwnershipTransferSourceGrantRequest(params),
        createBinding(context)
      )
    }
  }),
  sourceMethod(
    PTY_OWNERSHIP_TRANSFER_RUNTIME_METHODS.prepareSource,
    RuntimeOwnedPtyMutation,
    parsePtyOwnershipTransferPrepareRequest,
    (source, request, binding) => source.prepare(request, binding)
  ),
  sourceMethod(
    PTY_OWNERSHIP_TRANSFER_RUNTIME_METHODS.replaySource,
    RuntimeOwnedPtyMutation,
    parsePtyOwnershipTransferReplayRequest,
    (source, request, binding) => source.replay(request, binding)
  ),
  sourceMethod(
    PTY_OWNERSHIP_TRANSFER_RUNTIME_METHODS.commitSource,
    RuntimeOwnedPtyMutation,
    parsePtyOwnershipTransferCommitRequest,
    (source, request, binding) => source.commit(request, binding)
  ),
  sourceMethod(
    PTY_OWNERSHIP_TRANSFER_RUNTIME_METHODS.publishSource,
    RuntimeOwnedPtyMutation,
    parsePtyOwnershipTransferPublishRequest,
    (source, request, binding) => source.publish(request, binding)
  ),
  sourceMethod(
    PTY_OWNERSHIP_TRANSFER_RUNTIME_METHODS.inputSource,
    RuntimeOwnedPtyMutation,
    parsePtyOwnershipTransferInputRequest,
    (source, request, binding) => source.acceptInput(request, binding)
  ),
  sourceMethod(
    PTY_OWNERSHIP_TRANSFER_RUNTIME_METHODS.retireInputSource,
    RuntimeOwnedPtyMutation,
    parsePtyOwnershipTransferRetireInputRequest,
    (source, request, binding) => source.retireInput(request, binding)
  ),
  sourceMethod(
    PTY_OWNERSHIP_TRANSFER_RUNTIME_METHODS.attachSource,
    RuntimeOwnedPtyMutation,
    parsePtyOwnershipTransferAttachmentRequest,
    (source, request, binding) => source.attachDestination(request, binding)
  ),
  sourceMethod(
    PTY_OWNERSHIP_TRANSFER_RUNTIME_METHODS.rekeyReconnectSource,
    RuntimeOwnedPtyMutation,
    parsePtyOwnershipTransferReconnectRekeyRequest,
    (source, request, binding) => source.rekeyReconnect(request, binding)
  ),
  sourceMethod(
    PTY_OWNERSHIP_TRANSFER_RUNTIME_METHODS.controlSource,
    RuntimeOwnedPtyMutation,
    parsePtyOwnershipTransferControlRequest,
    (source, request, binding) => source.controlDestination(request, binding)
  ),
  sourceMethod(
    PTY_OWNERSHIP_TRANSFER_RUNTIME_METHODS.abortSource,
    RuntimeOwnedPtyMutation,
    parsePtyOwnershipTransferAbortRequest,
    (source, request, binding) => source.abort(request, binding)
  ),
  sourceMethod(
    PTY_OWNERSHIP_TRANSFER_RUNTIME_METHODS.acknowledgeOutputSource,
    RuntimeOwnedPtyMutation,
    parsePtyOwnershipTransferOutputAcknowledgementRequest,
    (source, request, binding) => source.acknowledgeDestinationOutput(request, binding)
  ),
  PTY_TRANSFER_SOURCE_STREAM_METHOD
]

function sourceMethod<T>(
  name: string,
  params: z.ZodType,
  parse: (value: unknown) => T,
  invoke: (
    source: RuntimePtyOwnershipTransferSourceAdapter,
    request: T,
    binding: Parameters<RuntimePtyOwnershipTransferSourceAdapter['prepare']>[1]
  ) => unknown
): RpcMethod {
  return defineMethod({
    name,
    params,
    handler: (value, context) => {
      requirePairedRuntimeClient(context)
      return invoke(getSource(context), parse(value), createBinding(context))
    }
  })
}
