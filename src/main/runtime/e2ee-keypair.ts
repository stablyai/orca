// QR public keys let paired clients derive application-layer ECDH encryption over plain WebSockets.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import nacl from 'tweetnacl'
import {
  hardenExistingSecureFile,
  isUnreadableError,
  writeSecureJsonFile
} from '../../shared/secure-file'
import {
  E2EE_KEYPAIR_FILENAME as KEYPAIR_FILENAME,
  MAX_E2EE_KEYPAIR_FILE_BYTES as MAX_KEYPAIR_FILE_BYTES
} from '../../shared/runtime-e2ee-keypair-file'

const KEYPAIR_VERSION = 1

type KeypairFile = {
  v: number
  publicKeyB64: string
  secretKeyB64: string
}

export type E2EEKeypair = {
  publicKey: Uint8Array
  secretKey: Uint8Array
  publicKeyB64: string
}

// Advertise the key derived from the listener's secret, not a mismatched stored public key; leave the file intact.
function keypairFromSecret(secretKey: Uint8Array, storedPublicKey: Uint8Array): E2EEKeypair {
  const { publicKey } = nacl.box.keyPair.fromSecretKey(secretKey)
  if (!Buffer.from(publicKey).equals(Buffer.from(storedPublicKey))) {
    console.warn(
      '[e2ee] stored public key does not match the secret key; advertising the derived key'
    )
  }
  return { publicKey, secretKey, publicKeyB64: Buffer.from(publicKey).toString('base64') }
}

export function loadOrCreateE2EEKeypair(userDataPath: string): E2EEKeypair {
  const filePath = join(userDataPath, KEYPAIR_FILENAME)

  if (existsSync(filePath)) {
    try {
      hardenExistingSecureFile(filePath)
      // Bound synchronous startup reads; valid keypair files are tiny.
      if (statSync(filePath).size > MAX_KEYPAIR_FILE_BYTES) {
        throw new Error('E2EE keypair file is too large')
      }
      const raw: KeypairFile = JSON.parse(readFileSync(filePath, 'utf-8'))
      if (raw.v === KEYPAIR_VERSION && raw.publicKeyB64 && raw.secretKeyB64) {
        const publicKey = Uint8Array.from(Buffer.from(raw.publicKeyB64, 'base64'))
        const secretKey = Uint8Array.from(Buffer.from(raw.secretKeyB64, 'base64'))
        if (publicKey.length === 32 && secretKey.length === 32) {
          return keypairFromSecret(secretKey, publicKey)
        }
      }
    } catch (error) {
      // Permission failure proves no corruption; regenerating would overwrite the only secret, unpair all devices and lose old-message decryption.
      if (isUnreadableError(error)) {
        throw new Error(
          `Cannot read the E2EE keypair at ${filePath}: the read failed. Refusing to regenerate it, which would invalidate every paired device.`,
          { cause: error }
        )
      }
      // Replace malformed files below.
    }
  }

  const keypair = nacl.box.keyPair()
  const publicKeyB64 = Buffer.from(keypair.publicKey).toString('base64')
  const secretKeyB64 = Buffer.from(keypair.secretKey).toString('base64')

  const data: KeypairFile = { v: KEYPAIR_VERSION, publicKeyB64, secretKeyB64 }
  writeSecureJsonFile(filePath, data)

  return { publicKey: keypair.publicKey, secretKey: keypair.secretKey, publicKeyB64 }
}
