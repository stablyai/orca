import { isKeyedObject } from '../bridged-parity/divergence-evidence'
import type { RecordedValue } from './recording-values'

export function rows(value: RecordedValue): Record<string, RecordedValue>[] {
  if (!Array.isArray(value)) {
    throw new Error('Missing reviewed recorded rows')
  }
  return value.map((row) => {
    if (!isKeyedObject(row)) {
      throw new Error('Missing reviewed recorded row')
    }
    return row
  })
}
