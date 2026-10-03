import AsyncStorage from '@react-native-async-storage/async-storage'
import { enqueueHostListMutation } from '../transport/host-list-mutation-queue'
import { SshProfileSchema, type SshProfile } from './ssh-profile'

const STORAGE_KEY = 'orca:ssh-connection-profiles'

export async function loadSshProfiles(): Promise<SshProfile[]> {
  const raw = await AsyncStorage.getItem(STORAGE_KEY)
  if (raw === null) {
    return []
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) {
      return []
    }
    // Why: pre-universal profiles carried jump settings that no longer parse.
    return parsed.flatMap((item) => {
      const result = SshProfileSchema.safeParse(item)
      return result.success ? [result.data] : []
    })
  } catch {
    return []
  }
}

// Why: cleanup prunes credentials by id, so an unparseable profile must still
// contribute its id or the sweep deletes a secret the user still owns.
export async function loadSshProfileIds(): Promise<string[]> {
  const raw = await AsyncStorage.getItem(STORAGE_KEY)
  if (raw === null) {
    return []
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) {
      return []
    }
    return parsed.flatMap((item) => {
      const id = SshProfileSchema.shape.id.safeParse(item?.id)
      return id.success ? [id.data] : []
    })
  } catch {
    return []
  }
}

export function saveSshProfile(profile: SshProfile): Promise<void> {
  const validated = SshProfileSchema.parse(profile)
  return enqueueHostListMutation(async () => {
    const profiles = await loadSshProfiles()
    const next = [validated, ...profiles.filter((entry) => entry.id !== validated.id)]
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  })
}

export function deleteSshProfile(id: string): Promise<void> {
  return enqueueHostListMutation(async () => {
    const profiles = await loadSshProfiles()
    const next = profiles
      .filter((entry) => entry.id !== id)
      // Why: a dangling jump reference would fail every dial; drop it silently.
      .map((entry) => (entry.jumpProfileId === id ? { ...entry, jumpProfileId: undefined } : entry))
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  })
}
