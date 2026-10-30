import { randomBytes } from 'node:crypto'

export function mintAgentSessionOperationId(now: number): string {
  return `${String(now).padStart(13, '0')}-${randomBytes(16).toString('hex')}`
}
