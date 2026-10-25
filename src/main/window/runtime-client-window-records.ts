import type { PersistedRuntimeClientWindow } from '../../shared/persisted-ui-state-types'
import type { WindowRect } from './window-bounds-validation'

export type RuntimeClientWindowRecord = PersistedRuntimeClientWindow

/** Persisted slot records, validated: the UI file is untyped JSON an older or newer build may have written. */
export function readRuntimeClientWindowRecords(raw: unknown): RuntimeClientWindowRecord[] {
  if (!Array.isArray(raw)) {
    return []
  }
  const bySlot = new Map<number, RuntimeClientWindowRecord>()
  for (const entry of raw) {
    const record = parseRecord(entry)
    if (record && !bySlot.has(record.slot)) {
      bySlot.set(record.slot, record)
    }
  }
  return [...bySlot.values()].sort((a, b) => a.slot - b.slot)
}

function parseRecord(entry: unknown): RuntimeClientWindowRecord | null {
  if (!entry || typeof entry !== 'object' || !('slot' in entry)) {
    return null
  }
  const { slot } = entry
  if (typeof slot !== 'number' || !Number.isInteger(slot) || slot < 1) {
    return null
  }
  const deviceId = 'deviceId' in entry ? entry.deviceId : undefined
  const webClientOrigin = 'webClientOrigin' in entry ? entry.webClientOrigin : undefined
  const bounds = 'bounds' in entry ? parseRect(entry.bounds) : null
  return {
    slot,
    ...(typeof deviceId === 'string' && deviceId ? { deviceId } : {}),
    ...(typeof webClientOrigin === 'string' && webClientOrigin ? { webClientOrigin } : {}),
    ...('open' in entry && entry.open === true ? { open: true } : {}),
    ...(bounds ? { bounds } : {}),
    ...('isMaximized' in entry && entry.isMaximized === true ? { isMaximized: true } : {})
  }
}

function parseRect(value: unknown): WindowRect | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const x = 'x' in value ? value.x : undefined
  const y = 'y' in value ? value.y : undefined
  const width = 'width' in value ? value.width : undefined
  const height = 'height' in value ? value.height : undefined
  return isFiniteNumber(x) && isFiniteNumber(y) && isFiniteNumber(width) && isFiniteNumber(height)
    ? { x, y, width, height }
    : null
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}
