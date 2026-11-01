import type { SendRequestOptions } from '../../transport/rpc-client'
import {
  RpcEnvelopeFieldsSchema,
  type RpcEnvelopeFields
} from '../../transport/rpc-envelope-fields'
import {
  BridgeRpcEnvelopeInvalidError,
  BridgeRpcEnvelopeUngrantedError
} from './bridge-client-errors'
import { BRIDGE_RPC_ENVELOPE_GRANT } from './bridge-frame-fields'

type HasGrant = (name: string) => boolean

// Validate with the shell’s schema before posting, or it drops the frame without reply. Absent/empty metadata omits the field to preserve existing frames.
export function readBridgeRpcEnvelope(
  fields: RpcEnvelopeFields | undefined,
  hasGrant: HasGrant
): RpcEnvelopeFields | undefined {
  if (fields === undefined) {
    return undefined
  }
  // Validate before the empty shortcut so [], Date and null cannot masquerade as no envelope.
  const parsed = RpcEnvelopeFieldsSchema.safeParse(fields)
  if (!parsed.success) {
    throw new BridgeRpcEnvelopeInvalidError()
  }
  if (Object.keys(parsed.data).length === 0) {
    return undefined
  }
  if (!hasGrant(BRIDGE_RPC_ENVELOPE_GRANT)) {
    throw new BridgeRpcEnvelopeUngrantedError()
  }
  return parsed.data
}

// An envelope-only options bag omits options on the wire, preserving the shell’s replayed request arity.
export function readBridgeRequestFrameOptions(
  requestOptions: SendRequestOptions | undefined,
  hasGrant: HasGrant
): { options?: Omit<SendRequestOptions, 'envelope'>; envelope?: RpcEnvelopeFields } {
  if (requestOptions === undefined) {
    return {}
  }
  const { envelope: fields, ...options } = requestOptions
  const envelope = readBridgeRpcEnvelope(fields, hasGrant)
  return {
    ...(fields !== undefined && Object.keys(options).length === 0 ? {} : { options }),
    ...(envelope === undefined ? {} : { envelope })
  }
}
