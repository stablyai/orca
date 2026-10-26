import { z } from 'zod'
import {
  isRpcDeliveryUnknown,
  markRpcDeliveryUnknown
} from '../../transport/rpc-delivery-ambiguity'

// Capture rejected promises, not RpcFailure data replies. Preserve the recorder’s five error fields, never stacks.
export type BridgeErrorCapture = {
  category: string
  message: string
  isRpcDeliveryUnknown: boolean
  code?: unknown
  cause?: BridgeErrorCapture
}

// Match recorder cause depth; truncate deeper chains instead of losing the whole rejection.
export const BRIDGE_MAX_CAUSE_DEPTH = 4

// Budget every error field for worst-case six-byte JSON escapes across five cause levels so the receiver cannot drop its only rejection frame.
export const BRIDGE_MAX_ERROR_MESSAGE_CHARS = 16 * 1024
export const BRIDGE_MAX_ERROR_CODE_CHARS = 4 * 1024

export const BRIDGE_TRUNCATION_MARK = ' [truncated]'

function boundMessage(message: string): string {
  return message.length > BRIDGE_MAX_ERROR_MESSAGE_CHARS
    ? `${message.slice(0, BRIDGE_MAX_ERROR_MESSAGE_CHARS)}${BRIDGE_TRUNCATION_MARK}`
    : message
}

// Drop oversized/unserializable codes rather than truncate them into different codes; carry the measured JSON snapshot so stateful toJSON cannot change its size later.
function boundCode(code: unknown): { code?: unknown } {
  if (code === undefined) {
    return {}
  }
  try {
    const serialized = JSON.stringify(code)
    if (serialized === undefined || serialized.length > BRIDGE_MAX_ERROR_CODE_CHARS) {
      return {}
    }
    return { code: JSON.parse(serialized) }
  } catch {
    return {}
  }
}

function errorCaptureSchema(remainingCauses: number): z.ZodType<BridgeErrorCapture> {
  const fields = {
    category: z.string(),
    message: z.string(),
    isRpcDeliveryUnknown: z.boolean(),
    code: z.unknown().optional()
  }
  return remainingCauses === 0
    ? z.object(fields)
    : z.object({ ...fields, cause: errorCaptureSchema(remainingCauses - 1).optional() })
}

export const BridgeErrorCaptureSchema = errorCaptureSchema(BRIDGE_MAX_CAUSE_DEPTH)

// Read code and cause separately through checked schemas; either getter may throw and must cost only its own field.
const errorCodeSchema = z.object({ code: z.unknown().optional() })
const errorCauseSchema = z.object({ cause: z.unknown().optional() })

// Always produce a capture; throwing getters drop only their fields, never the envelope that settles the request.
function readDetail<TDetail>(error: Error, schema: z.ZodType<TDetail>): TDetail | undefined {
  try {
    const parsed = schema.safeParse(error)
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

export const BRIDGE_UNREADABLE_ERROR_MESSAGE = 'error could not be read'

// Guard arbitrary message/constructor getters and String(value): thrown user code must not prevent the request’s rejection envelope.
export function captureBridgeError(error: unknown, depth = 0): BridgeErrorCapture {
  try {
    return capture(error, depth)
  } catch {
    return {
      category: 'Error',
      message: BRIDGE_UNREADABLE_ERROR_MESSAGE,
      isRpcDeliveryUnknown: readDeliveryUnknownMark(error)
    }
  }
}

// instanceof can throw for revoked proxies, including in the fallback.
function readDeliveryUnknownMark(error: unknown): boolean {
  try {
    return isRpcDeliveryUnknown(error)
  } catch {
    return false
  }
}

function capture(error: unknown, depth: number): BridgeErrorCapture {
  if (!(error instanceof Error)) {
    return {
      category: typeof error,
      message: boundMessage(String(error)),
      isRpcDeliveryUnknown: false
    }
  }
  const code = readDetail(error, errorCodeSchema)?.code
  const cause = readDetail(error, errorCauseSchema)?.cause
  return {
    category: error.constructor.name,
    message: boundMessage(error.message),
    isRpcDeliveryUnknown: isRpcDeliveryUnknown(error),
    ...boundCode(code),
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

const RECONSTRUCTED_CLASS_LIMIT = 64

// Rename the reconstructed class, not the instance: golden recorders inspect error.constructor.name.
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

// Restore the delivery-unknown WeakSet mark after serialization; losing object identity must not turn executed requests into retryable definite failures.
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
