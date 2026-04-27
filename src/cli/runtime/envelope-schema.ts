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

export const RuntimeRpcEnvelopeSchema = z.discriminatedUnion('ok', [Success, Failure])
