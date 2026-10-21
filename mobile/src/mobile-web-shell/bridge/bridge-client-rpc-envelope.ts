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

/**
 * The `envelope` a page frame carries for a caller's extra wire fields; throws instead of sending.
 *
 * Absent and empty both mean no field, so a caller passing neither posts today's exact frame. The
 * check is the shell reader's own schema: a frame that reader drops is answered by nothing, and the
 * caller would wait for the life of the page.
 */
export function readBridgeRpcEnvelope(
  fields: RpcEnvelopeFields | undefined,
  hasGrant: HasGrant
): RpcEnvelopeFields | undefined {
  if (fields === undefined) {
    return undefined
  }
  // Checked before the empty shortcut, so `[]`, a `Date` or `null` is refused, not read as empty.
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

/**
 * A request's `options` and `envelope` frame fields. A bag that held only the envelope crosses as
 * no `options`, so the shell replays the arity it did before the envelope existed.
 */
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
