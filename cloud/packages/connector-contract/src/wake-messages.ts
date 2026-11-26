import { z } from 'zod'

// The wake channel: a socket that only says "poll now". A machine lists this feature in its hello;
// only then may the hello answer carry a `wake` offer. Without an offer the machine long-polls.
export const CONNECTOR_WAKE_FEATURE = 'connector-wake-v1'

export const CONNECTOR_WAKE_PATH = '/v1/connector/wake'
// Milliseconds since the machine's previous wake socket closed, sent on the upgrade.
export const CONNECTOR_WAKE_GAP_HEADER = 'x-orca-wake-gap-ms'
// The wake token's audience and purpose (minted by auth beside the connector token).
export const CONNECTOR_WAKE_TOKEN_AUDIENCE = 'orca-connector-wake'
export const CONNECTOR_WAKE_TOKEN_PURPOSE = 'connector-wake'

// Exact frames, so the server can answer a keepalive without waking the host's object. They match
// the relay's client keepalive frames. The machine sends a keepalive every interval.
export const CONNECTOR_WAKE_FRAME = '{"type":"wake"}'
// Sent instead of the wake frame for an admin call with kind `shares_changed`.
export const CONNECTOR_SHARES_CHANGED_FRAME = '{"type":"shares_changed"}'
export const CONNECTOR_WAKE_KEEPALIVE_FRAME = '{"type":"keepalive"}'
export const CONNECTOR_WAKE_KEEPALIVE_ACK_FRAME = '{"type":"keepalive-ack"}'
export const CONNECTOR_WAKE_KEEPALIVE_INTERVAL_MS = 25_000
// Inbound frames above this close the socket with FRAME_TOO_BIG.
export const CONNECTOR_WAKE_MAX_INBOUND_FRAME_BYTES = 1024

// The longest hold a poll's `holdMs` gets; the cloud clamps it to 0..this.
export const CONNECTOR_WAKE_MAX_HOLD_MS = 5_000

const isLoopbackHost = (host: string) =>
  host === 'localhost' || host === '127.0.0.1' || host === '[::1]'

// wss only; plain ws only to loopback, for local runs.
const WakeUrlSchema = z
  .url()
  .max(2048)
  .refine((value) => {
    const url = URL.parse(value)
    return url?.protocol === 'wss:' || (url?.protocol === 'ws:' && isLoopbackHost(url.hostname))
  })

export const ConnectorWakeOfferSchema = z.object({
  wakeUrl: WakeUrlSchema,
  // Idle safety poll interval; the machine adds its own jitter. Capped so a lost wake is still
  // picked up before a delivery's 5-minute ttl.
  safetyPollMs: z.number().int().min(30_000).max(240_000)
})

// A hello answer's offer, read leniently: one this machine can't read is dropped, so it long-polls
// instead of failing the hello.
export const ConnectorHelloWakeOfferSchema = ConnectorWakeOfferSchema.optional().catch(undefined)

// Close codes of the wake socket (relay values where the meaning matches). Before the upgrade the
// server may also answer 401 (bad token, as BAD_TOKEN) or 503 + Retry-After (no key set).
export const CONNECTOR_WAKE_CLOSE_CODE = {
  FRAME_TOO_BIG: 1009,
  BAD_TOKEN: 4401,
  COUNTRY_REFUSED: 4403,
  REPLACED: 4409,
  LIMITED: 4429
} as const

export type ConnectorWakeCloseCode =
  (typeof CONNECTOR_WAKE_CLOSE_CODE)[keyof typeof CONNECTOR_WAKE_CLOSE_CODE]

// What the machine does after the socket closes with a code:
// refresh-token: refresh the wake token once and redial; a second failure counts as a failed connect.
// until-hello: long-poll until the next hello (no redial).
// backoff: redial with backoff, counting a failed connect.
export type ConnectorWakeCloseAction = 'refresh-token' | 'until-hello' | 'backoff'

export function connectorWakeCloseAction(code: number): ConnectorWakeCloseAction {
  switch (code) {
    case CONNECTOR_WAKE_CLOSE_CODE.BAD_TOKEN:
      return 'refresh-token'
    case CONNECTOR_WAKE_CLOSE_CODE.COUNTRY_REFUSED:
    case CONNECTOR_WAKE_CLOSE_CODE.REPLACED:
    case CONNECTOR_WAKE_CLOSE_CODE.FRAME_TOO_BIG:
      return 'until-hello'
    default:
      return 'backoff'
  }
}

// Cloud → wake service: `POST /__admin/wake`, authenticated by an HS256 token with this audience,
// purpose and op, and the SHA-256 of the exact body.
export const CONNECTOR_WAKE_ADMIN_PATH = '/__admin/wake'
export const CONNECTOR_WAKE_ADMIN_AUDIENCE = 'orca-connector-wake-admin'
export const CONNECTOR_WAKE_ADMIN_PURPOSE = 'connector-wake-admin'
export const CONNECTOR_WAKE_ADMIN_OP = 'wake'
export const CONNECTOR_WAKE_ADMIN_MAX_HOSTS = 500
export const CONNECTOR_WAKE_ADMIN_BODY_MAX_BYTES = 256 * 1024

// A connector host id: the token's `${sub}:${mid}`; mid's alphabet has no ':'.
export const ConnectorWakeHostIdSchema = z
  .string()
  .max(256)
  .regex(/^[^:].*:[A-Za-z0-9_-]{16,64}$/)

// Without a kind the hosts get the plain wake frame.
export const ConnectorWakeKindSchema = z.enum(['shares_changed'])

export const ConnectorWakeAdminRequestSchema = z
  .object({
    hosts: z.array(ConnectorWakeHostIdSchema).min(1).max(CONNECTOR_WAKE_ADMIN_MAX_HOSTS),
    kind: ConnectorWakeKindSchema.optional()
  })
  .strict()

export function connectorWakeFrame(kind: ConnectorWakeKind | undefined): string {
  return kind === 'shares_changed' ? CONNECTOR_SHARES_CHANGED_FRAME : CONNECTOR_WAKE_FRAME
}

// Counts only, never host ids.
export const ConnectorWakeAdminResponseSchema = z.object({
  delivered: z.number().int().nonnegative(),
  noSocket: z.number().int().nonnegative(),
  error: z.number().int().nonnegative()
})

export type ConnectorWakeOffer = z.infer<typeof ConnectorWakeOfferSchema>
export type ConnectorWakeKind = z.infer<typeof ConnectorWakeKindSchema>
export type ConnectorWakeAdminRequest = z.infer<typeof ConnectorWakeAdminRequestSchema>
export type ConnectorWakeAdminResponse = z.infer<typeof ConnectorWakeAdminResponseSchema>
