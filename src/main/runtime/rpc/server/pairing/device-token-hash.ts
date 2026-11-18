import { createHash } from 'node:crypto'

/** What the registry stores for a bearer token: reading the file yields nothing that signs in. */
export function hashDeviceToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}
