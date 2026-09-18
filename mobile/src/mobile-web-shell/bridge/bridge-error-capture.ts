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
// getter that defines one is still worth reading. One schema each, because reading either property
// runs whatever getter defined it, and a getter that throws must not cost the other field.
const errorCodeSchema = z.object({ code: z.unknown().optional() })
const errorCauseSchema = z.object({ cause: z.unknown().optional() })

/**
 * A rejection is the one thing that always has to produce a capture: an error thrown while reading
 * an error leaves the page with no envelope at all, so a throwing getter costs its own field only.
 */
function readDetail<TDetail>(error: Error, schema: z.ZodType<TDetail>): TDetail | undefined {
  try {
    const parsed = schema.safeParse(error)
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

/** What crosses when the error cannot be read at all. The mark is a `WeakSet` lookup, so it holds. */
export const BRIDGE_UNREADABLE_ERROR_MESSAGE = 'error could not be read'

/**
 * `message` and `constructor` can be getters too, and `String(value)` runs a `toString` the thrower
 * wrote. Every read here is someone else's code, so the whole capture is guarded: a rejection that
 * produced no envelope at all would leave the page with a promise that never settles.
 */
export function captureBridgeError(error: unknown, depth = 0): BridgeErrorCapture {
  try {
    return capture(error, depth)
  } catch {
    return {
      category: 'Error',
      message: BRIDGE_UNREADABLE_ERROR_MESSAGE,
      isRpcDeliveryUnknown: isRpcDeliveryUnknown(error)
    }
  }
}

function capture(error: unknown, depth: number): BridgeErrorCapture {
  if (!(error instanceof Error)) {
    return { category: typeof error, message: String(error), isRpcDeliveryUnknown: false }
  }
  const code = readDetail(error, errorCodeSchema)?.code
  const cause = readDetail(error, errorCauseSchema)?.cause
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
