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

export function captureError(error: unknown): RecordedValue {
  return {
    category: error instanceof Error ? error.constructor.name : typeof error,
    message: error instanceof Error ? error.message : String(error),
    isRpcDeliveryUnknown: isRpcDeliveryUnknown(error)
  }
}

export type Settlement =
  | { status: 'pending' }
  | { status: 'fulfilled'; value: RecordedValue }
  | { status: 'rejected'; error: RecordedValue }

export function observeSettlement(value: unknown, update: (state: Settlement) => void): void {
  update({ status: 'pending' })
  Promise.resolve(value).then(
    (result) => update({ status: 'fulfilled', value: captureValue(result) }),
    (error: unknown) => update({ status: 'rejected', error: captureError(error) })
  )
}
