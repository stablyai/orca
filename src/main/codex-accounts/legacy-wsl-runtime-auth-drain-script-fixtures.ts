import { createHash } from 'node:crypto'

export const isWindows = process.platform === 'win32'

export const SOURCE_AUTH = '{"tokens":{"expires_at":2000}}\n'
export const TARGET_AUTH = '{"tokens":{"expires_at":1000}}\n'
export const NEWER_AUTH = '{"tokens":{"expires_at":3000}}\n'
export const INTRUDER_AUTH = '{"tokens":{"expires_at":9000}}\n'

export const TORN_AUTH = '{"tokens":{"exp'
export const SOURCE_CREDENTIALS = '{"server":{"access_token":"source"}}\n'
export const TORN_CREDENTIALS = '{"server":'
export const RETIRED_SESSION = '{"session":"retired"}\n'
export const RETIRED_SESSION_SEGMENTS = ['sessions', '2026', '08', '26', 'retired.jsonl']

export function sha256(contents: string): string {
  return createHash('sha256').update(contents).digest('hex')
}
