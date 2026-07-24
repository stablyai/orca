// Why: the E2EE keypair enables application-layer encryption between mobile
// and desktop over plain ws://. The public key is embedded in the QR pairing
// offer so the mobile client can derive a shared secret via ECDH.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import nacl from 'tweetnacl'
import { readNodeFileSyncWithinLimit } from '../../shared/node-bounded-file-reader'
import { assertJsonTextStructureWithinLimits } from '../../shared/json-text-structure-limit'
import { hardenExistingSecureFile, writeSecureJsonFile } from '../../shared/secure-file'
import { E2EE_KEYPAIR_FILENAME } from './mobile-pairing-files'

const KEYPAIR_FILENAME = E2EE_KEYPAIR_FILENAME
const KEYPAIR_VERSION = 1
export const MAX_KEYPAIR_FILE_BYTES = 8 * 1024
export const MAX_KEYPAIR_JSON_STRUCTURAL_TOKENS = 2048
export const MAX_KEYPAIR_JSON_NESTING_DEPTH = 8

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

export function loadOrCreateE2EEKeypair(userDataPath: string): E2EEKeypair {
  const filePath = join(userDataPath, KEYPAIR_FILENAME)

  if (existsSync(filePath)) {
    try {
      hardenExistingSecureFile(filePath)
      const serialized = readNodeFileSyncWithinLimit(
        filePath,
        MAX_KEYPAIR_FILE_BYTES
      ).buffer.toString('utf8')
      assertJsonTextStructureWithinLimits(serialized, {
        structuralTokens: MAX_KEYPAIR_JSON_STRUCTURAL_TOKENS,
        nestingDepth: MAX_KEYPAIR_JSON_NESTING_DEPTH
      })
      const raw = JSON.parse(serialized) as KeypairFile
      if (raw.v === KEYPAIR_VERSION && raw.publicKeyB64 && raw.secretKeyB64) {
        const publicKey = Uint8Array.from(Buffer.from(raw.publicKeyB64, 'base64'))
        const secretKey = Uint8Array.from(Buffer.from(raw.secretKeyB64, 'base64'))
        if (publicKey.length === 32 && secretKey.length === 32) {
          return { publicKey, secretKey, publicKeyB64: raw.publicKeyB64 }
        }
      }
    } catch {
      // Malformed file — regenerate below.
    }
  }

  const keypair = nacl.box.keyPair()
  const publicKeyB64 = Buffer.from(keypair.publicKey).toString('base64')
  const secretKeyB64 = Buffer.from(keypair.secretKey).toString('base64')

  const data: KeypairFile = { v: KEYPAIR_VERSION, publicKeyB64, secretKeyB64 }
  writeSecureJsonFile(filePath, data)

  return { publicKey: keypair.publicKey, secretKey: keypair.secretKey, publicKeyB64 }
}
