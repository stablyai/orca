import { StoredHostProfileSchema, type StoredHostProfile } from './types'
import { parseMobileJsonTextWithinLimits } from './mobile-json-text-admission'

export const STORED_HOSTS_MAX_ENTRIES = 256
export const STORED_HOSTS_MAX_STORAGE_CHARACTERS = 8 * 1024 * 1024

export function parseMobileStoredHostList(raw: string | null): StoredHostProfile[] | null {
  if (!raw) {
    return []
  }
  if (raw.length > STORED_HOSTS_MAX_STORAGE_CHARACTERS) {
    return null
  }
  try {
    const parsed = parseMobileJsonTextWithinLimits(raw)
    if (!Array.isArray(parsed) || parsed.length > STORED_HOSTS_MAX_ENTRIES) {
      return null
    }
    return parsed.flatMap((item) => {
      // Why: pre-v0.0.3 records stored deviceToken in AsyncStorage; dropping
      // them keeps bearer material out of the metadata migration path.
      if (item && typeof item === 'object' && 'deviceToken' in item) {
        return []
      }
      const result = StoredHostProfileSchema.safeParse(item)
      return result.success ? [result.data] : []
    })
  } catch {
    return null
  }
}

export function serializeMobileStoredHostList(hosts: StoredHostProfile[]): string {
  if (hosts.length > STORED_HOSTS_MAX_ENTRIES) {
    throw new Error('host list storage limit exceeded')
  }
  const validated = hosts.map((host) => StoredHostProfileSchema.parse(host))
  const serialized = JSON.stringify(validated)
  if (serialized.length > STORED_HOSTS_MAX_STORAGE_CHARACTERS) {
    throw new Error('host list storage limit exceeded')
  }
  return serialized
}
