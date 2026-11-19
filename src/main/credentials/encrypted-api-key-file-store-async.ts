import { open, readFile, rename, rm, stat, mkdir, chmod } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { getSecretStore } from '../../shared/secure-storage/secret-store'
import type { SecretAtRestProtection } from '../../shared/secure-storage/secret-at-rest-protection'

const UNSUPPORTED_DIRECTORY_FSYNC_CODES = new Set(['EINVAL', 'ENOTSUP', 'EOPNOTSUPP'])

type EncryptedApiKeyFileStore = {
  envelopeFile: () => { path: string; envelopePrefix: string }
  protection: () => Promise<SecretAtRestProtection | null>
  has: () => Promise<boolean>
  hasCached: () => boolean
  save: (key: string) => Promise<void>
  read: () => Promise<string | null>
  clear: () => Promise<void>
}

export function createEncryptedApiKeyFileStoreAsync({
  fileName,
  envelopePrefix,
  providerLabel,
  logScope,
  singleLine = false,
  requireRestrictedPlaintext = false
}: {
  fileName: string
  envelopePrefix: string
  providerLabel: string
  logScope: string
  singleLine?: boolean
  requireRestrictedPlaintext?: boolean
}): EncryptedApiKeyFileStore {
  let cachedApiKey: string | null = null
  let cachedPresence = false
  let warnedHardenFailure = false
  let operations = Promise.resolve()

  type Envelope = { kind: 'encrypted' | 'plaintext'; payload: Buffer }

  function path(): string {
    return join(homedir(), '.orca', fileName)
  }

  function encode(kind: Envelope['kind'], payload: Buffer): string {
    return `${envelopePrefix}${kind}:${payload.toString('base64')}`
  }

  function decode(raw: Buffer): Envelope {
    const text = raw.toString('utf8')
    if (!text.startsWith(envelopePrefix)) {
      throw new Error(`${providerLabel} API key could not be decrypted`)
    }
    const rest = text.slice(envelopePrefix.length)
    const separator = rest.indexOf(':')
    const kind = rest.slice(0, separator)
    if (separator === -1 || (kind !== 'encrypted' && kind !== 'plaintext')) {
      throw new Error(`${providerLabel} API key could not be decrypted`)
    }
    return { kind, payload: Buffer.from(rest.slice(separator + 1), 'base64') }
  }

  function readEnvelope(envelope: Envelope): string {
    if (envelope.kind === 'plaintext') {
      return envelope.payload.toString('utf8')
    }
    if (!getSecretStore().isEncryptionAvailable()) {
      throw new Error(`${providerLabel} API key could not be decrypted`)
    }
    return getSecretStore().decryptString(envelope.payload)
  }

  function run<T>(operation: () => Promise<T>): Promise<T> {
    const result = operations.then(operation)
    operations = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  async function hardenExisting(keyPath: string): Promise<void> {
    if (process.platform === 'win32') {
      return
    }
    try {
      await chmod(dirname(keyPath), 0o700)
      await chmod(keyPath, 0o600)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (!['EPERM', 'EACCES', 'EROFS'].includes(code ?? '')) {
        throw error
      }
    }
  }

  async function write(contents: string): Promise<void> {
    const keyPath = path()
    const directory = dirname(keyPath)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const temporaryPath = `${keyPath}.${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}.tmp`
    try {
      if (process.platform !== 'win32') {
        await chmod(directory, 0o700)
      }
      const file = await open(temporaryPath, 'wx', 0o600)
      try {
        await file.writeFile(contents, 'utf8')
        if (process.platform !== 'win32') {
          await file.chmod(0o600)
        }
        await file.sync()
      } finally {
        await file.close()
      }
      await rename(temporaryPath, keyPath)
      if (process.platform !== 'win32') {
        const directoryFile = await open(directory, 'r')
        try {
          try {
            await directoryFile.sync()
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code
            if (!UNSUPPORTED_DIRECTORY_FSYNC_CODES.has(code ?? '')) {
              throw error
            }
          }
        } finally {
          await directoryFile.close()
        }
      }
    } catch (error) {
      await rm(temporaryPath, { force: true })
      throw error
    }
  }

  return {
    envelopeFile: () => ({ path: path(), envelopePrefix }),
    hasCached: () => cachedPresence,
    has: () =>
      run(async () => {
        try {
          const keyPath = path()
          await stat(keyPath)
          try {
            await hardenExisting(keyPath)
          } catch (error) {
            if (!warnedHardenFailure) {
              warnedHardenFailure = true
              console.warn(
                `[${logScope}] Failed to harden ${providerLabel} API key file while checking status`,
                error
              )
            }
          }
          cachedPresence = true
        } catch (error) {
          cachedPresence = (error as NodeJS.ErrnoException).code !== 'ENOENT'
        }
        return cachedPresence
      }),
    protection: () =>
      run(async () => {
        try {
          const keyPath = path()
          await hardenExisting(keyPath)
          const envelope = decode(await readFile(keyPath))
          cachedPresence = true
          return envelope.kind === 'plaintext' ? 'plaintext' : 'sealed'
        } catch (error) {
          cachedPresence = (error as NodeJS.ErrnoException).code !== 'ENOENT'
          return null
        }
      }),
    save: (key) =>
      run(async () => {
        const trimmed = key.trim()
        if (!trimmed) {
          throw new Error(`${providerLabel} API key is required`)
        }
        if (singleLine && /[\r\n]/.test(trimmed)) {
          throw new Error(`${providerLabel} API key must be a single line`)
        }
        const secretStore = getSecretStore()
        if (secretStore.isEncryptionAvailable()) {
          await write(encode('encrypted', secretStore.encryptString(trimmed)))
        } else {
          if (requireRestrictedPlaintext && process.platform === 'win32') {
            throw new Error(`${providerLabel} API key could not be stored securely on this device`)
          }
          console.warn(
            `[${logScope}] safeStorage encryption unavailable — storing ${providerLabel} API key in plaintext`
          )
          await write(encode('plaintext', Buffer.from(trimmed, 'utf8')))
        }
        cachedApiKey = trimmed
        cachedPresence = true
      }),
    read: () =>
      run(async () => {
        if (cachedApiKey !== null) {
          return cachedApiKey
        }
        try {
          const keyPath = path()
          try {
            await hardenExisting(keyPath)
          } catch (error) {
            console.warn(
              `[${logScope}] Failed to harden ${providerLabel} API key file while reading`,
              error
            )
          }
          const raw = await readFile(keyPath)
          cachedApiKey = readEnvelope(decode(raw))
          cachedPresence = true
          return cachedApiKey
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            cachedPresence = false
            return null
          }
          cachedPresence = true
          console.error(`[${logScope}] failed to decode/decrypt API key`, error)
          throw new Error(`${providerLabel} API key could not be decrypted`)
        }
      }),
    clear: () =>
      run(async () => {
        await rm(path(), { force: true })
        cachedApiKey = null
        cachedPresence = false
      })
  }
}
