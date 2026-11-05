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
      .map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        if (!descriptor || !('value' in descriptor)) {
          throw new Error('Observation requires own data properties')
        }
        return [key, captureValue(descriptor.value)] as const
      })
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
    value:
      index < args.length
        ? index === 2
          ? captureRequestOptions(args[index])
          : captureValue(args[index])
        : { $rpc: 'absent' }
  }))
}

function captureRequestOptions(options: unknown): RecordedValue {
  if (options && typeof options === 'object') {
    for (const key of Reflect.ownKeys(options)) {
      const descriptor = Object.getOwnPropertyDescriptor(options, key)
      if (typeof key !== 'string' || !descriptor || !('value' in descriptor)) {
        throw new Error('Request options require string own data properties')
      }
    }
  }
  if (
    options !== null &&
    typeof options === 'object' &&
    [Object.prototype, null].includes(Object.getPrototypeOf(options)) &&
    Object.hasOwn(options, 'beforeSend') &&
    'beforeSend' in options &&
    typeof options.beforeSend === 'function'
  ) {
    // This copy is evidence only; the original options and callback go to the real client.
    return captureValue({ ...options, beforeSend: '[local beforeSend]' })
  }
  return captureValue(options)
}

/** `code` and `cause` are recorded only when present, so an error without them keeps three fields. */
export function captureError(error: unknown, depth = 0): RecordedValue {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: code and cause are read defensively; a thrown value carries neither by type.
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

// Virtual settlement timestamps make deadline/debounce changes observable without scenarios straddling each duration.
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
  update: (state: Settlement) => void,
  onFault?: (error: unknown) => void,
  onRejected?: (error: unknown) => void
): void {
  const startedAt = now()
  update({ status: 'pending', startedAt })
  void Promise.resolve(value)
    .then(
      (result) =>
        update({ status: 'fulfilled', startedAt, settledAt: now(), value: captureValue(result) }),
      (error: unknown) => {
        update({ status: 'rejected', startedAt, settledAt: now(), error: captureError(error) })
        onRejected?.(error)
      }
    )
    .catch((error: unknown) => {
      if (onFault) {
        onFault(error)
      } else {
        throw error
      }
    })
}
