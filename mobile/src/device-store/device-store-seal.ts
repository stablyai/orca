import { AESSealedData, aesDecryptAsync, aesEncryptAsync, type AESEncryptionKey } from 'expo-crypto'

export type DeviceStoreTable = 'cache' | 'draft'

// What a sealed file is bound to; a file copied or renamed to another value fails its tag.
export type DeviceStoreValueBinding = {
  readonly hostId: string
  readonly table: DeviceStoreTable
  readonly key: string
}

const encoder = new TextEncoder()

// Bytes, not a string: expo-crypto reads string additional data as base64.
function additionalData({ hostId, table, key }: DeviceStoreValueBinding): Uint8Array {
  return encoder.encode(`${hostId}\0${table}\0${key}`)
}

// The value is base64 and passes through as-is: expo-crypto decodes string input as base64 natively.
export async function sealDeviceStoreValue(
  cryptoKey: AESEncryptionKey,
  binding: DeviceStoreValueBinding,
  value: string
): Promise<Uint8Array> {
  const sealed = await aesEncryptAsync(value, cryptoKey, {
    additionalData: additionalData(binding)
  })
  return sealed.combined()
}

// Null for a torn, tampered or moved file: its tag fails against this value's binding.
export async function openDeviceStoreValue(
  cryptoKey: AESEncryptionKey,
  binding: DeviceStoreValueBinding,
  bytes: Uint8Array
): Promise<string | null> {
  try {
    return await aesDecryptAsync(AESSealedData.fromCombined(bytes), cryptoKey, {
      output: 'base64',
      additionalData: additionalData(binding)
    })
  } catch {
    return null
  }
}
