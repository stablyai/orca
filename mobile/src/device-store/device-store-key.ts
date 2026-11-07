import { AESEncryptionKey, AESKeySize } from 'expo-crypto'
import { withTimeoutResult } from '../../../src/shared/promise-timeout-fallback'

// Stored through the pairing keychain: WHEN_UNLOCKED_THIS_DEVICE_ONLY keeps it off iCloud and backups,
// and its Android generation rotation recovers alias faults (#6600) that one fixed alias could hit forever.
export const DEVICE_STORE_KEY_ITEM = 'orca.device-store-key.v1'

// Keychain calls can stall behind other keychain work; every store call waits on the key, so bound it.
const KEYCHAIN_TIMEOUT_MS = 5000

export type DeviceStoreKeychain = {
  read(): Promise<string | null>
  write(hexKey: string): Promise<void>
}

export type DeviceStoreKeyLoad = {
  readonly keychain: DeviceStoreKeychain
  hasStoredValues(): Promise<boolean>
  wipeAllValues(): Promise<void>
}

// Null means unavailable (a locked phone, a transient keystore error): nothing is deleted and the caller
// retries on the next foreground. A missing key while files exist means the key is lost (Android alias
// fault, restored backup, reinstall that kept files): those files can never open again, so wipe and remint.
export async function loadDeviceStoreKey(
  load: DeviceStoreKeyLoad
): Promise<AESEncryptionKey | null> {
  // A timeout or a throw is unavailable, never "no key": that would wipe a store that is only locked.
  const read = await withTimeoutResult(load.keychain.read(), KEYCHAIN_TIMEOUT_MS)
  if (!read.ok) {
    return null
  }
  const stored = read.value
  if (stored !== null) {
    const imported = await AESEncryptionKey.import(stored, 'hex').catch(() => null)
    if (imported) {
      return imported
    }
  }
  try {
    if (await load.hasStoredValues()) {
      await load.wipeAllValues()
    }
    const minted = await AESEncryptionKey.generate(AESKeySize.AES256)
    const written = await withTimeoutResult(
      load.keychain.write(await minted.encoded('hex')),
      KEYCHAIN_TIMEOUT_MS
    )
    return written.ok ? minted : null
  } catch {
    return null
  }
}
