import { asRecord } from './session-record-fields'

export function timestampMs(value: unknown): number {
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : Number.NaN
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return Number.NaN
  }
  const milliseconds = value > 1_000_000_000_000 ? value : value * 1000
  // Finite numbers can still exceed Date's range and make transcript ISO serialization throw.
  return milliseconds <= 8_640_000_000_000_000 ? milliseconds : Number.NaN
}

export function timeObjectValue(value: unknown, key: string): string | null {
  const record = asRecord(value)
  if (!record) {
    return null
  }
  const rawValue = record[key]
  if (typeof rawValue === 'string') {
    return rawValue
  }
  const parsed = timestampMs(rawValue)
  if (!Number.isFinite(parsed)) {
    return null
  }
  return new Date(parsed).toISOString()
}
