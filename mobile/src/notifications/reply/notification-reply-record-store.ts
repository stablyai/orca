import AsyncStorage from '@react-native-async-storage/async-storage'
import { AESEncryptionKey, AESKeySize } from 'expo-crypto'
import {
  readPairingKeychainItem,
  writePairingKeychainItem
} from '../../host-credentials/pairing-keychain'
import { sealDeviceStoreValue, openDeviceStoreValue } from '../../device-store/device-store-seal'
import {
  encodeDeviceStoreValue,
  decodeDeviceStoreValue
} from '../../device-store/device-store-value-codec'
import { encodeBase64Bytes, decodeBase64Bytes } from '../../transport/encryption/base64-byte-codec'

const KEY = 'orca.notification-reply-key.v1'
const SEALED = 'sealed:v1:'
let loadingKey: Promise<AESEncryptionKey> | null = null

function encryptionKey(): Promise<AESEncryptionKey> {
  loadingKey ??= (async () => {
    const stored = await readPairingKeychainItem(KEY)
    if (stored !== null) {
      return AESEncryptionKey.import(stored, 'hex')
    }
    for (const key of await AsyncStorage.getAllKeys()) {
      if (
        key.startsWith('orca:notificationReply:') &&
        (await AsyncStorage.getItem(key))?.startsWith(SEALED)
      ) {
        throw new Error('Notification reply recovery key is unavailable')
      }
    }
    const key = await AESEncryptionKey.generate(AESKeySize.AES256)
    await writePairingKeychainItem(KEY, await key.encoded('hex'))
    return key
  })().catch((error: unknown) => {
    loadingKey = null
    throw error
  })
  return loadingKey
}

const binding = (key: string) => ({ hostId: 'notification-reply', table: 'draft' as const, key })

export const notificationReplyRecords = {
  async getItem(key: string): Promise<string | null> {
    const raw = await AsyncStorage.getItem(key)
    if (raw === null) {
      return null
    }
    if (!raw.startsWith(SEALED)) {
      // Migrate existing recovery text before returning it to any caller.
      await notificationReplyRecords.setItem(key, raw)
      return raw
    }
    const opened = await openDeviceStoreValue(
      await encryptionKey(),
      binding(key),
      decodeBase64Bytes(raw.slice(SEALED.length))
    )
    const value = opened === null ? undefined : decodeDeviceStoreValue(opened)
    if (typeof value !== 'string') {
      throw new Error('Notification reply record could not be opened')
    }
    return value
  },
  async setItem(key: string, value: string): Promise<void> {
    const bytes = await sealDeviceStoreValue(
      await encryptionKey(),
      binding(key),
      encodeDeviceStoreValue(value)
    )
    await AsyncStorage.setItem(key, SEALED + encodeBase64Bytes(bytes))
  },
  getAllKeys: () => AsyncStorage.getAllKeys(),
  removeItem: (key: string) => AsyncStorage.removeItem(key)
}
