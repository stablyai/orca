import { randomBytes } from 'node:crypto'

export function generateId(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString('hex')}`
}
