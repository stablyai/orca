import { createHash } from 'node:crypto'

export function hashDispatchCapability(capability: string): string {
  return createHash('sha256').update(capability).digest('hex')
}
