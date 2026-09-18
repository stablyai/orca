import { z } from 'zod'
import {
  isRpcDeliveryUnknown,
  markRpcDeliveryUnknown
} from '../../transport/rpc-delivery-ambiguity'

/**
 * A rejection of `sendRequest` crossing the bridge, and the error the page raises from it.
 *
 * A host `RpcFailure` is not this: that is data and rides in `reply` untouched. This is the other
 * path, the one where the promise rejects, and it carries exactly the five fields the golden
 * recorder reads off an error. No stack, ever.
 */
export type BridgeErrorCapture = {
  category: string
  message: string
  isRpcDeliveryUnknown: boolean
  code?: unknown
  cause?: BridgeErrorCapture
}

/**
 * Matches the recorder's own cause depth, so a chain it would record is a chain that crosses. A
 * deeper chain is truncated at this level rather than refused: losing the error entirely because
 * its fifth cause was one too many is the worse of the two failures.
 */
export const BRIDGE_MAX_CAUSE_DEPTH = 4

function errorCaptureSchema(remainingCauses: number): z.ZodType<BridgeErrorCapture> {
  const fields = {
    category: z.string(),
    message: z.string(),
    isRpcDeliveryUnknown: z.boolean(),
    // Whatever shape the code has: the recorder records every present code, so narrowing here
    // would drop a field from a rejection the goldens already hold.
    code: z.unknown().optional()
  }
  return remainingCauses === 0
    ? z.object(fields)
    : z.object({ ...fields, cause: errorCaptureSchema(remainingCauses - 1).optional() })
}

export const BridgeErrorCaptureSchema = errorCaptureSchema(BRIDGE_MAX_CAUSE_DEPTH)

// Read through a schema rather than an assertion: `code` and `cause` are not on `Error`, and a
// getter that defines one is still worth reading.
const errorDetailSchema = z.object({
  code: z.unknown().optional(),
  cause: z.unknown().optional()
})

export function captureBridgeError(error: unknown, depth = 0): BridgeErrorCapture {
  if (!(error instanceof Error)) {
    return { category: typeof error, message: String(error), isRpcDeliveryUnknown: false }
  }
  const detail = errorDetailSchema.safeParse(error)
  const code = detail.success ? detail.data.code : undefined
  const cause = detail.success ? detail.data.cause : undefined
  return {
    category: error.constructor.name,
    message: error.message,
    isRpcDeliveryUnknown: isRpcDeliveryUnknown(error),
    ...(code === undefined ? {} : { code }),
    ...(cause !== undefined && depth < BRIDGE_MAX_CAUSE_DEPTH
      ? { cause: captureBridgeError(cause, depth + 1) }
      : {})
  }
}

class BridgeReconstructedError extends Error {
  code?: unknown
}

type ReconstructedErrorClass = new (message: string) => BridgeReconstructedError

const reconstructedClasses = new Map<string, ReconstructedErrorClass>()

/** Bounds a map keyed by a name that arrives over the wire; past it, classes are built per error. */
const RECONSTRUCTED_CLASS_LIMIT = 64

/**
 * The recorder reads `error.constructor.name`, so reconstructing every rejection as a plain `Error`
 * would move every golden that records one. The class is renamed rather than the instance for that
 * reason.
 */
function errorClassFor(category: string): ReconstructedErrorClass {
  const cached = reconstructedClasses.get(category)
  if (cached !== undefined) {
    return cached
  }
  const created = class extends BridgeReconstructedError {}
  Object.defineProperty(created, 'name', { value: category })
  if (reconstructedClasses.size < RECONSTRUCTED_CLASS_LIMIT) {
    reconstructedClasses.set(category, created)
  }
  return created
}

/**
 * Re-applying the delivery-unknown mark is the whole reason this is a function and not a `new
 * Error`: the mark is a `WeakSet` on object identity, so it cannot survive serialization, and a
 * caller that reads it as a definite send failure will offer to retry something the host already ran.
 */
export function reconstructBridgeError(capture: BridgeErrorCapture): Error {
  const created = new (errorClassFor(capture.category))(capture.message)
  created.name = capture.category
  if (capture.code !== undefined) {
    created.code = capture.code
  }
  if (capture.cause !== undefined) {
    created.cause = reconstructBridgeError(capture.cause)
  }
  return capture.isRpcDeliveryUnknown ? markRpcDeliveryUnknown(created) : created
}
