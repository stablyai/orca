import { randomBytes } from 'node:crypto'

const GENERATED_ID_BYTES = 6

export function generateId(prefix: string): string {
  return `${prefix}_${randomBytes(GENERATED_ID_BYTES).toString('hex')}`
}

/** Whether `value` has the exact shape `generateId(prefix)` produces. */
export function isGeneratedId(value: string, prefix: string): boolean {
  const marker = `${prefix}_`
  if (!value.startsWith(marker)) {
    return false
  }
  const hex = value.slice(marker.length)
  return hex.length === GENERATED_ID_BYTES * 2 && /^[0-9a-f]+$/i.test(hex)
}
