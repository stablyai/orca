import { z } from 'zod'

// Every route is POST except hello (PUT), with `Authorization: Bearer <connector token>`: the 5-minute
// token Orca's auth service mints for a signed-in machine. The machine is that token's (sub, mid), the
// user and the per-install machine id. A 401 means fetch a new token and try again.
export const CONNECTOR_PATHS = {
  hello: '/v1/connector/hello',
  poll: '/v1/connector/poll',
  acks: '/v1/connector/acks',
  events: '/v1/connector/events',
  replies: '/v1/connector/replies'
} as const

export const CONNECTOR_ERROR_CODES = [
  'invalid_token',
  'hello_required',
  'request_too_large',
  'client_too_old',
  'not_this_hosts_thread'
] as const
export type ConnectorErrorCode = (typeof CONNECTOR_ERROR_CODES)[number]

// Codes stay open so an older machine reads a newer one as a plain failure.
export const ConnectorErrorResponseSchema = z.object({ error: z.string().min(1) })
