import { createHash } from 'node:crypto'
import type { CursorAuthReadResult } from './cursor-auth'

export function cursorCredentialKey(auth: CursorAuthReadResult): string | null {
  return auth.status === 'ok' ? createHash('sha256').update(auth.accessToken).digest('hex') : null
}
