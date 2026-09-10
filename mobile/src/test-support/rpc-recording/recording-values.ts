import { isRpcDeliveryUnknown } from '../../transport/rpc-delivery-ambiguity'

export type RecordedValue =
  | null
  | boolean
  | number
  | string
  | RecordedValue[]
  | {
      [key: string]: RecordedValue
    }

export function captureValue(value: unknown): RecordedValue {
  if (value === undefined) {
    return { $rpc: 'undefined' }
  }
  if (value === null) {
    return { $rpc: 'null' }
  }
  if (Array.isArray(value)) {
    return value.map(captureValue)
  }
  if (typeof value === 'object') {
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
      throw new Error('Observation requires an explicit projection for non-plain objects')
    }
    const entries = Object.keys(value)
      .sort()
      .map((key) => [key, captureValue((value as Record<string, unknown>)[key])] as const)
    return '$rpc' in value
      ? { $rpc: 'object', entries: entries.map(([key, entry]) => [key, entry]) }
      : Object.fromEntries(entries)
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return { $rpc: 'number', value: String(value) }
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }
  throw new Error(`Unsupported observation: ${typeof value}`)
}

export function captureArguments(args: readonly unknown[]): RecordedValue {
  return ['method', 'params', 'options'].map((name, index) => ({
    name,
    value: index < args.length ? captureValue(args[index]) : { $rpc: 'absent' }
  }))
}

/** `code` and `cause` are recorded only when present, so an error without them keeps three fields. */
export function captureError(error: unknown, depth = 0): RecordedValue {
  const detail = error as { code?: unknown; cause?: unknown }
  const code = error instanceof Error ? detail.code : undefined
  const cause = error instanceof Error && depth < 4 ? detail.cause : undefined
  return {
    category: error instanceof Error ? error.constructor.name : typeof error,
    message: error instanceof Error ? error.message : String(error),
    isRpcDeliveryUnknown: isRpcDeliveryUnknown(error),
    ...(code === undefined ? {} : { code: captureValue(code) }),
    ...(cause === undefined ? {} : { cause: captureError(cause, depth + 1) })
  }
}

/**
 * `startedAt` and `settledAt` are virtual milliseconds on the pinned fake clock. They give the
 * observation a temporal dimension: a transition the product schedules for itself, such as a
 * request deadline or a debounce, is recorded at the time it actually happens, so any change to
 * that duration moves a recorded number rather than needing a scenario placed across it.
 */
export type Settlement =
  | { status: 'pending'; startedAt: number }
  | { status: 'fulfilled'; startedAt: number; settledAt: number; value: RecordedValue }
  | { status: 'rejected'; startedAt: number; settledAt: number; error: RecordedValue }

export function rejectedSettlement(error: unknown, at: number): Settlement {
  return { status: 'rejected', startedAt: at, settledAt: at, error: captureError(error) }
}

export function observeSettlement(
  value: unknown,
  now: () => number,
  update: (state: Settlement) => void
): void {
  const startedAt = now()
  update({ status: 'pending', startedAt })
  Promise.resolve(value).then(
    (result) =>
      update({ status: 'fulfilled', startedAt, settledAt: now(), value: captureValue(result) }),
    (error: unknown) =>
      update({ status: 'rejected', startedAt, settledAt: now(), error: captureError(error) })
  )
}
