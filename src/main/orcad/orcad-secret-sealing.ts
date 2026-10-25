/** AES-256-GCM sealing for orcad's SecretStore; the key comes from orcad-secret-store.ts. */
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto'

// Why a leading NUL: classifyUnenvelopedCredential reports control bytes as 'sealed', so a
// sealed file can never be mistaken for a legacy plaintext token.
const MAGIC = Buffer.from([0x00, 0x4f, 0x48, 0x01])
const IV_BYTES = 12
const TAG_BYTES = 16
const KEY_INFO = 'orca-headless-secret-store/v1'

export const ORCAD_MASTER_KEY_BYTES = 32

/** Binds the stored master key to `hostBinding` so a copied profile cannot unseal elsewhere. */
export function deriveOrcadSealingKey(masterKey: Buffer, hostBinding: string): Buffer {
  return Buffer.from(hkdfSync('sha256', masterKey, hostBinding, KEY_INFO, ORCAD_MASTER_KEY_BYTES))
}

/** Detects a wrong key (changed machine identity, replaced keyring item) without a sealed sample. */
export function orcadSealingKeyCheck(key: Buffer): string {
  return createHmac('sha256', key).update('orca-headless-secret-store/check').digest('hex')
}

export function sealOrcadSecret(key: Buffer, plainText: string): Buffer {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(MAGIC)
  const body = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()])
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body])
}

export function openOrcadSecret(key: Buffer, sealed: Buffer): string {
  const header = MAGIC.length + IV_BYTES + TAG_BYTES
  if (sealed.length < header || !sealed.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('orcad_secret_not_sealed_by_this_host')
  }
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key,
    sealed.subarray(MAGIC.length, MAGIC.length + IV_BYTES)
  )
  decipher.setAAD(MAGIC)
  decipher.setAuthTag(sealed.subarray(MAGIC.length + IV_BYTES, header))
  return Buffer.concat([decipher.update(sealed.subarray(header)), decipher.final()]).toString(
    'utf8'
  )
}
