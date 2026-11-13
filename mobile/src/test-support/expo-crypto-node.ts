import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'

// Alias the native-only crypto module to Node’s secure source for Vitest; explicit per-test mocks still win.
export function getRandomBytes(byteCount: number): Uint8Array {
  return new Uint8Array(randomBytes(byteCount))
}

export { randomUUID }

type BinaryInput = string | Uint8Array | ArrayBuffer

export enum AESKeySize {
  AES128 = 128,
  AES192 = 192,
  AES256 = 256
}

// Expo reads string BinaryInput as base64, so the stand-in must too.
function binaryInputBytes(input: BinaryInput): Buffer {
  if (typeof input === 'string') {
    return Buffer.from(input, 'base64')
  }
  return Buffer.from(input instanceof ArrayBuffer ? new Uint8Array(input) : input)
}

const IV_BYTES = 12
const TAG_BYTES = 16

export class AESEncryptionKey {
  private constructor(private readonly keyBytes: Buffer) {}
  get size(): AESKeySize {
    const size = this.keyBytes.byteLength * 8
    if (size !== 128 && size !== 192 && size !== 256) {
      throw new Error('invalid AES key length')
    }
    return size
  }
  static async generate(size: AESKeySize = AESKeySize.AES256): Promise<AESEncryptionKey> {
    return new AESEncryptionKey(randomBytes(size / 8))
  }
  static async import(
    input: string | Uint8Array,
    encoding?: 'hex' | 'base64'
  ): Promise<AESEncryptionKey> {
    const bytes =
      typeof input === 'string' ? Buffer.from(input, encoding ?? 'hex') : Buffer.from(input)
    if (![16, 24, 32].includes(bytes.byteLength)) {
      throw new Error('invalid AES key length')
    }
    return new AESEncryptionKey(bytes)
  }
  async bytes(): Promise<Uint8Array> {
    return new Uint8Array(this.keyBytes)
  }
  async encoded(encoding: 'hex' | 'base64'): Promise<string> {
    return this.keyBytes.toString(encoding)
  }
  cipherKey(): Buffer {
    return this.keyBytes
  }
}

export class AESSealedData {
  private constructor(private readonly combinedBytes: Buffer) {}
  static fromCombined(combined: BinaryInput): AESSealedData {
    return new AESSealedData(binaryInputBytes(combined))
  }
  async combined(encoding?: 'bytes' | 'base64'): Promise<Uint8Array | string> {
    return encoding === 'base64'
      ? this.combinedBytes.toString('base64')
      : new Uint8Array(this.combinedBytes)
  }
  parts(): { iv: Buffer; ciphertext: Buffer; tag: Buffer } {
    const bytes = this.combinedBytes
    return {
      iv: bytes.subarray(0, IV_BYTES),
      ciphertext: bytes.subarray(IV_BYTES, bytes.byteLength - TAG_BYTES),
      tag: bytes.subarray(bytes.byteLength - TAG_BYTES)
    }
  }
}

const CIPHER_BY_KEY_SIZE = {
  128: 'aes-128-gcm',
  192: 'aes-192-gcm',
  256: 'aes-256-gcm'
} as const satisfies Record<AESKeySize, string>

function cipherName(key: AESEncryptionKey): (typeof CIPHER_BY_KEY_SIZE)[AESKeySize] {
  return CIPHER_BY_KEY_SIZE[key.size]
}

export async function aesEncryptAsync(
  plaintext: BinaryInput,
  key: AESEncryptionKey,
  options: { additionalData?: BinaryInput } = {}
): Promise<AESSealedData> {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(cipherName(key), key.cipherKey(), iv)
  if (options.additionalData !== undefined) {
    cipher.setAAD(binaryInputBytes(options.additionalData))
  }
  const ciphertext = Buffer.concat([cipher.update(binaryInputBytes(plaintext)), cipher.final()])
  return AESSealedData.fromCombined(Buffer.concat([iv, ciphertext, cipher.getAuthTag()]))
}

export async function aesDecryptAsync(
  sealed: AESSealedData,
  key: AESEncryptionKey,
  options: { output?: 'bytes' | 'base64'; additionalData?: BinaryInput } = {}
): Promise<Uint8Array | string> {
  const { iv, ciphertext, tag } = sealed.parts()
  const decipher = createDecipheriv(cipherName(key), key.cipherKey(), iv)
  decipher.setAuthTag(tag)
  if (options.additionalData !== undefined) {
    decipher.setAAD(binaryInputBytes(options.additionalData))
  }
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return options.output === 'base64' ? plaintext.toString('base64') : new Uint8Array(plaintext)
}
