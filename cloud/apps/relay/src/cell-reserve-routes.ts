import type { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import {
  CELL_DEMOTE_PATH,
  CELL_RESERVE_PATH,
  DemoteRequestSchema,
  ReserveRequestSchema,
  type DemoteRequest,
  type ReserveOutcome,
  type ReserveRequest
} from './cell-reserve-contract.js'
import type { RelayConfig } from './config.js'
import { readBearer } from './relay-token-verifier.js'

const MAX_BODY_BYTES = 16 * 1024
// The app-wide 4 KiB body limit skips these; they enforce their own larger one.
export const CELL_RESERVE_ROUTE_PATHS: ReadonlySet<string> = new Set([
  CELL_RESERVE_PATH,
  CELL_DEMOTE_PATH
])
const limitBody = bodyLimit({
  maxSize: MAX_BODY_BYTES,
  onError: (context) => context.json({ error: 'request_too_large' }, 413)
})

// Reuse director rehome credentials for writes; directors can already place any host via DB, so these grant no new authority.
export function registerCellReserveRoutes(
  app: Hono,
  config: RelayConfig,
  input: {
    verifyRegionalRehomeToken: (token: string) => Promise<boolean>
    reserve?: (request: ReserveRequest) => ReserveOutcome[]
    demote?: (request: DemoteRequest) => string
  }
): void {
  const authorize = async (header: string | undefined): Promise<'ok' | 404 | 401> => {
    if (config.role !== 'cell' || !input.reserve || !input.demote) return 404
    if (!config.rehomeAudience || !config.rehomeDirectorServiceAccount) return 404
    const bearer = readBearer(header)
    return bearer && (await input.verifyRegionalRehomeToken(bearer)) ? 'ok' : 401
  }
  const unauthorized = (status: 404 | 401) =>
    status === 404 ? { error: 'reserve_unavailable' } : { error: 'invalid_token' }

  app.post(CELL_RESERVE_PATH, limitBody, async (context) => {
    const auth = await authorize(context.req.header('authorization'))
    if (auth !== 'ok') return context.json(unauthorized(auth), auth)
    if (Number(context.req.header('content-length') ?? 0) > MAX_BODY_BYTES) {
      return context.json({ error: 'request_too_large' }, 413)
    }
    const body = ReserveRequestSchema.safeParse(await context.req.json().catch(() => null))
    if (!body.success) return context.json({ error: 'invalid_request' }, 400)
    return context.json({ v: 1, results: input.reserve!(body.data) })
  })

  app.post(CELL_DEMOTE_PATH, limitBody, async (context) => {
    const auth = await authorize(context.req.header('authorization'))
    if (auth !== 'ok') return context.json(unauthorized(auth), auth)
    if (Number(context.req.header('content-length') ?? 0) > MAX_BODY_BYTES) {
      return context.json({ error: 'request_too_large' }, 413)
    }
    const body = DemoteRequestSchema.safeParse(await context.req.json().catch(() => null))
    if (!body.success) return context.json({ error: 'invalid_request' }, 400)
    return context.json({ v: 1, outcome: input.demote!(body.data) })
  })
}
