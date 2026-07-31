import { StoredHostProfileSchema, type StoredHostProfile } from './types'

export function parseMobileStoredHostList(raw: string | null): StoredHostProfile[] | null {
  if (!raw) {
    return []
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) {
      return null
    }
    return parsed.flatMap((item) => {
      // Why: pre-v0.0.3 records stored deviceToken in AsyncStorage; drop them instead of retaining plaintext credentials.
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
