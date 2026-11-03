import AsyncStorage from '@react-native-async-storage/async-storage'
import { persistMirrored } from './mirrored-storage-keys'

const KEY = 'orca:relayBackgroundExtended'
let extended = false
let revision = 0
let pendingWrite: Promise<void> = Promise.resolve()

export function isRelayBackgroundExtended(): boolean {
  return extended
}

export async function loadRelayBackgroundExtended(): Promise<boolean> {
  const readRevision = revision
  await pendingWrite
  const raw = await AsyncStorage.getItem(KEY)
  if (readRevision === revision) {
    extended = raw === 'true'
  }
  return extended
}

export function saveRelayBackgroundExtended(value: boolean): Promise<void> {
  revision += 1
  const writeRevision = revision
  const previous = extended
  extended = value
  const write = pendingWrite.then(async () => {
    try {
      await persistMirrored(KEY, String(value))
    } catch (error) {
      if (revision === writeRevision) {
        extended = previous
      }
      throw error
    }
  })
  pendingWrite = write.catch(() => undefined)
  return write
}
