// Why: the Orca runtime is a separate process and may drift in version from
// the CLI (older CLI talking to newer app, or vice versa during dev HMR). A
// Zod schema at the decode boundary means a malformed frame surfaces as a
// single legible error instead of a silent mis-typed access downstream.
//
// The envelope shape mirrors src/main/runtime/rpc/core.ts. `result` is left
// unknown here — method-level types are checked by the caller via generics —
// so only the frame is validated, not the payload.
import { z } from 'zod'

const MetaSuccess = z.object({
  runtimeId: z.string()
})

const MetaFailure = z
  .object({
    runtimeId: z.union([z.string(), z.null()])
  })
  .optional()

const Success = z.object({
  id: z.string(),
  ok: z.literal(true),
  result: z.unknown(),
  _meta: MetaSuccess
})

const Failure = z.object({
  id: z.string(),
  ok: z.literal(false),
  error: z.object({
    code: z.string(),
    message: z.string(),
    data: z.unknown().optional()
  }),
  _meta: MetaFailure
})

// Why: transport-layer keepalive frame (server→client only). Not a terminal
// frame — the client reads past it and keeps waiting for the real
// success/failure. `id` and `_meta` are deliberately absent: keepalives carry
// no method-level semantics and aren't tied to a particular request (one
// connection handles one request today). See design doc §3.1.
const Keepalive = z.object({
  _keepalive: z.literal(true)
})

// Why: switched from z.discriminatedUnion('ok', …) to z.union because
// keepalives have no `ok` field. Client code must branch on
// `'_keepalive' in frame` before treating the frame as Success/Failure.
export const RuntimeRpcEnvelopeSchema = z.union([Success, Failure, Keepalive])

export type RuntimeRpcKeepaliveFrame = z.infer<typeof Keepalive>

export function isKeepaliveFrame(frame: unknown): frame is RuntimeRpcKeepaliveFrame {
  return (
    typeof frame === 'object' &&
    frame !== null &&
    '_keepalive' in frame &&
    (frame as { _keepalive: unknown })._keepalive === true
  )
}
