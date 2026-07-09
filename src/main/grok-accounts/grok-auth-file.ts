import { readFileSync } from 'node:fs'
import { join } from 'node:path'

type GrokAuthRecord = {
  key?: unknown
  email?: unknown
  user_email?: unknown
  user_id?: unknown
}

export function readGrokAuthIdentity(managedHomePath: string): string | null {
  const parsed = JSON.parse(readFileSync(join(managedHomePath, 'auth.json'), 'utf-8')) as Record<
    string,
    unknown
  >
  for (const value of Object.values(parsed)) {
    const record = asAuthRecord(value)
    if (record?.key && typeof record.key === 'string') {
      const email = normalizeString(record.email ?? record.user_email ?? record.user_id)
      if (email) {
        return email
      }
    }
  }
  return null
}

function asAuthRecord(value: unknown): GrokAuthRecord | null {
  return typeof value === 'object' && value !== null ? (value as GrokAuthRecord) : null
}

function normalizeString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}
