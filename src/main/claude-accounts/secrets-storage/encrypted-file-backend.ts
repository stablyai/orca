import { promises as fsp } from 'node:fs'
import {
  type EncryptedFileV1,
  readEncryptedFile,
  recordKey,
  writeEncryptedFile
} from './encrypted-file-format'
import { deriveKey, generateSalt, SALT_BYTES } from './kdf'
import { decryptSecret, encryptSecret } from './secretbox'
import type { PassphraseHolder } from './passphrase-prompt'
import type { SecretsStorage } from './types'

export type EncryptedFileBackendDeps = {
  filePath: string
  holder: PassphraseHolder
  promptForPassphrase: (opts: { mode: 'unlock' | 'create' }) => Promise<string | null>
}

export function createEncryptedFileBackend(deps: EncryptedFileBackendDeps): SecretsStorage {
  const ensurePassphrase = async (mode: 'unlock' | 'create'): Promise<string> => {
    const cached = deps.holder.get()
    if (cached) {
      return cached
    }
    const result = await deps.promptForPassphrase({ mode })
    if (result === null) {
      throw new Error('Passphrase required to access Claude account secrets.')
    }
    return result
  }

  const loadOrInit = async (): Promise<{ file: EncryptedFileV1; key: Buffer }> => {
    const existing = await readEncryptedFile(deps.filePath)
    if (existing) {
      const pass = await ensurePassphrase('unlock')
      const salt = Buffer.from(existing.saltHex, 'hex')
      if (salt.length !== SALT_BYTES) {
        throw new Error('Encrypted secrets file is malformed: bad salt length.')
      }
      return { file: existing, key: deriveKey(pass, salt) }
    }
    const pass = await ensurePassphrase('create')
    const salt = generateSalt()
    const file: EncryptedFileV1 = {
      version: 1,
      saltHex: salt.toString('hex'),
      records: {}
    }
    return { file, key: deriveKey(pass, salt) }
  }

  return {
    backendId: 'encrypted-file',
    read: async (service, account) => {
      const existing = await readEncryptedFile(deps.filePath)
      if (!existing) {
        return null
      }
      const { key } = await loadOrInit()
      const rec = existing.records[recordKey(service, account)]
      if (!rec) {
        return null
      }
      return decryptSecret(
        Buffer.from(rec.ciphertextHex, 'hex'),
        Buffer.from(rec.nonceHex, 'hex'),
        key
      )
    },
    write: async (service, account, value) => {
      const { file, key } = await loadOrInit()
      const { ciphertext, nonce } = encryptSecret(value, key)
      file.records[recordKey(service, account)] = {
        ciphertextHex: ciphertext.toString('hex'),
        nonceHex: nonce.toString('hex')
      }
      await writeEncryptedFile(deps.filePath, file)
    },
    delete: async (service, account) => {
      const existing = await readEncryptedFile(deps.filePath)
      if (!existing) {
        return
      }
      const k = recordKey(service, account)
      if (!(k in existing.records)) {
        return
      }
      delete existing.records[k]
      await writeEncryptedFile(deps.filePath, existing)
    }
  }
}

// Irreversibly wipes the encrypted secrets file and clears the in-memory
// passphrase. All previously-stored secrets become unrecoverable; callers
// must accept that account records pointing into the file will need to be
// re-added before they can be materialized again.
export async function resetEncryptedSecretsFile(opts: {
  filePath: string
  holder: PassphraseHolder
}): Promise<void> {
  opts.holder.clear()
  try {
    await fsp.unlink(opts.filePath)
  } catch (error) {
    // ENOENT just means we already had no file — that's a successful reset.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }
}
