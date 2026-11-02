import { z } from 'zod'
import type { RpcRequest } from './types'

/**
 * Extra top-level fields for one outgoing RPC request, beside `params`.
 *
 * What a request needs at the top level changes with the host, so this is a plain JSON object the
 * physical sender copies verbatim rather than a list of known fields: a new one reaches the wire
 * without a new app binary. The page's bridge carries it under the same name and this schema.
 */
export const RpcEnvelopeFieldsSchema = z.record(z.string(), z.json())

export type RpcEnvelopeFields = z.infer<typeof RpcEnvelopeFieldsSchema>

// Key-exhaustive over the wire request, so a field the transport starts sending is protected too.
const TRANSPORT_FIELDS: Record<keyof RpcRequest, true> = {
  id: true,
  deviceToken: true,
  method: true,
  params: true
}

/** Every field the transport owns; none can be set through `RpcEnvelopeFields`. */
export const RPC_TRANSPORT_FIELDS: readonly string[] = Object.keys(TRANSPORT_FIELDS)

/** What a caller-facing transport hands its physical sender, which adds the credential. */
export type RpcRequestFrame = Omit<RpcRequest, 'deviceToken'> & { envelope?: RpcEnvelopeFields }

/**
 * The wire request with `fields` merged under it. Transport fields are dropped from `fields`
 * whether or not this request carries them, so an absent `params` cannot be filled in either.
 * Absent or empty fields hand back the request itself, which keeps today's bytes identical.
 */
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

/** The direct transport's wire request, in the key order its sockets and goldens have always had. */
export function buildDirectRpcWireRequest(
  { id, method, params, envelope }: RpcRequestFrame,
  deviceToken: string
): RpcRequest {
  return withRpcEnvelopeFields({ id, deviceToken, method, params }, envelope)
}
