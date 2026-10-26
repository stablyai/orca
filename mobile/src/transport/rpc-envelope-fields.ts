import { z } from 'zod'
import type { RpcRequest } from './types'

// Pass added top-level host fields through unchanged so new fields need no mobile binary update.
export const RpcEnvelopeFieldsSchema = z.record(z.string(), z.json())

export type RpcEnvelopeFields = z.infer<typeof RpcEnvelopeFieldsSchema>

// Key-exhaustive over the wire request, so a field the transport starts sending is protected too.
const TRANSPORT_FIELDS: Record<keyof RpcRequest, true> = {
  id: true,
  deviceToken: true,
  method: true,
  params: true
}

export const RPC_TRANSPORT_FIELDS: readonly string[] = Object.keys(TRANSPORT_FIELDS)

// Caller-facing frame; the physical sender adds the credential.
export type RpcRequestFrame = Omit<RpcRequest, 'deviceToken'> & { envelope?: RpcEnvelopeFields }

// Never fill transport-owned keys from fields, even when absent; preserve request identity when no fields are added.
export function withRpcEnvelopeFields(
  request: RpcRequest,
  fields: RpcEnvelopeFields | undefined
): RpcRequest {
  if (fields === undefined || Object.keys(fields).length === 0) {
    return request
  }
  const extra = Object.fromEntries(
    Object.entries(fields).filter(([key]) => !Object.hasOwn(TRANSPORT_FIELDS, key))
  )
  return { ...extra, ...request }
}

// Preserve the direct transport’s established wire key order.
export function buildDirectRpcWireRequest(
  { id, method, params, envelope }: RpcRequestFrame,
  deviceToken: string
): RpcRequest {
  return withRpcEnvelopeFields({ id, deviceToken, method, params }, envelope)
}
