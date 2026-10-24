// Why: the E2EE keypair enables application-layer encryption between mobile
// and desktop over plain ws://. The public key is embedded in the QR pairing
// offer so the mobile client can derive a shared secret via ECDH.
import { existsSync, readFileSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import nacl from 'tweetnacl'
import {
  hardenExistingSecureFile,
  isUnreadableError,
  writeDurableSecureJsonFile
} from '../../shared/secure-file'
import {
  E2EE_KEYPAIR_FILENAME as KEYPAIR_FILENAME,
  MAX_E2EE_KEYPAIR_FILE_BYTES as MAX_KEYPAIR_FILE_BYTES
} from '../../shared/runtime-e2ee-keypair-file'
import { MOBILE_PAIRING_USERDATA_FILES } from './mobile-pairing-files'

const KEYPAIR_VERSION = 1

type KeypairFile = {
  v: number
  publicKeyB64: string
  secretKeyB64: string
  /** `e2eeKeyHostBinding` of the machine that minted the key; absent on older files. */
  hostBinding?: string
}

const FROM_OTHER_HOST_SUFFIX = '.from-other-host'

export type E2EEKeypair = {
  publicKey: Uint8Array
  secretKey: Uint8Array
  publicKeyB64: string
}

// The listener decrypts with the secret key, so the advertised key must be the
// one derived from it; a file whose stored public key disagrees would otherwise
// put a key in every pairing offer that no listener holds. The file is left as is.
function keypairFromSecret(secretKey: Uint8Array, storedPublicKey: Uint8Array): E2EEKeypair {
  const { publicKey } = nacl.box.keyPair.fromSecretKey(secretKey)
  if (!Buffer.from(publicKey).equals(Buffer.from(storedPublicKey))) {
    console.warn(
      '[e2ee] stored public key does not match the secret key; advertising the derived key'
    )
  }
  return { publicKey, secretKey, publicKeyB64: Buffer.from(publicKey).toString('base64') }
}

// Kept beside the live files rather than deleted, so a wrongly detected move can be undone by hand.
// The key moves first: if it cannot, nothing is replaced. False when the key stayed in place.
function setAsidePairingIdentityFromOtherHost(userDataPath: string): boolean {
  const suffix = `${FROM_OTHER_HOST_SUFFIX}-${Date.now()}`
  const keyFirst = [
    KEYPAIR_FILENAME,
    ...MOBILE_PAIRING_USERDATA_FILES.filter((name) => name !== KEYPAIR_FILENAME)
  ]
  for (const name of keyFirst) {
    const path = join(userDataPath, name)
    try {
      if (existsSync(path)) {
        renameSync(path, `${path}${suffix}`)
      }
    } catch (error) {
      console.warn(`[e2ee] could not set aside ${name} from another host:`, error)
      if (name === KEYPAIR_FILENAME) {
        return false
      }
    }
  }
  return true
}

/**
 * `hostBinding` (see e2ee-keypair-host-binding.ts) is this machine's tag, or null where none is
 * trustworthy. A key minted on another machine is replaced, and the paired-device registry with it,
 * since every pairing in it was made with that machine's key. Callers must open the registry after.
 */
export function loadOrCreateE2EEKeypair(
  userDataPath: string,
  hostBinding: string | null = null
): E2EEKeypair {
  const filePath = join(userDataPath, KEYPAIR_FILENAME)

  if (existsSync(filePath)) {
    let stored: { raw: KeypairFile; publicKey: Uint8Array; secretKey: Uint8Array } | null = null
    try {
      hardenExistingSecureFile(filePath)
      // Why: this startup path reads synchronously; valid keypair files are
      // tiny, so oversized/corrupt files should be replaced without loading.
      if (statSync(filePath).size > MAX_KEYPAIR_FILE_BYTES) {
        throw new Error('E2EE keypair file is too large')
      }
      const raw: KeypairFile = JSON.parse(readFileSync(filePath, 'utf-8'))
      if (raw.v === KEYPAIR_VERSION && raw.publicKeyB64 && raw.secretKeyB64) {
        const publicKey = Uint8Array.from(Buffer.from(raw.publicKeyB64, 'base64'))
        const secretKey = Uint8Array.from(Buffer.from(raw.secretKeyB64, 'base64'))
        if (publicKey.length === 32 && secretKey.length === 32) {
          stored = { raw, publicKey, secretKey }
        }
      }
    } catch (error) {
      // A read this process is not permitted to make says nothing about the contents. Falling
      // through would overwrite the only copy of the secret key — and the overwrite succeeds, so
      // nothing downstream stops it. Every paired device derives its shared secret from this key,
      // so regenerating silently un-pairs all of them and no old message stays decryptable.
      if (isUnreadableError(error)) {
        throw new Error(
          `Cannot read the E2EE keypair at ${filePath}: the read failed. Refusing to regenerate it, which would invalidate every paired device.`,
          { cause: error }
        )
      }
      // Malformed file — regenerate below.
    }
    if (stored) {
      const recorded = typeof stored.raw.hostBinding === 'string' ? stored.raw.hostBinding : null
      if (!hostBinding || !recorded || recorded === hostBinding) {
        if (hostBinding && !recorded) {
          // A pre-binding key is adopted by whichever machine first runs this version.
          try {
            writeDurableSecureJsonFile(filePath, { ...stored.raw, hostBinding })
          } catch (error) {
            console.warn('[e2ee] could not record the host binding; will retry next start:', error)
          }
        }
        return keypairFromSecret(stored.secretKey, stored.publicKey)
      }
      if (!setAsidePairingIdentityFromOtherHost(userDataPath)) {
        return keypairFromSecret(stored.secretKey, stored.publicKey)
      }
      console.warn(
        `[e2ee] the E2EE keypair in ${userDataPath} was minted on another machine (cloned image?); minted a new one and set the old key and paired devices aside (*${FROM_OTHER_HOST_SUFFIX}-*). Phones must pair again, and a desktop that manages this server must remove and re-add it.`
      )
    }
  }

  const keypair = nacl.box.keyPair()
  const publicKeyB64 = Buffer.from(keypair.publicKey).toString('base64')
  const secretKeyB64 = Buffer.from(keypair.secretKey).toString('base64')

  const data: KeypairFile = {
    v: KEYPAIR_VERSION,
    publicKeyB64,
    secretKeyB64,
    ...(hostBinding ? { hostBinding } : {})
  }
  writeDurableSecureJsonFile(filePath, data)

  return { publicKey: keypair.publicKey, secretKey: keypair.secretKey, publicKeyB64 }
}
