import type * as NodeFsPromises from 'node:fs/promises'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { setSecretStore, _resetSecretStoreForTests } from '../../shared/secret-store'
import { createEncryptedAntigravityAccountStore } from './native-account-store'

const MAX_VAULT_BYTES = 4 * 1024 * 1024
const io = vi.hoisted(() => ({ consumed: 0 }))
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof NodeFsPromises>('node:fs/promises')
  return {
    ...actual,
    // Model a vault that grew past its checked size after the stat: the descriptor reports the
    // checked size while the file keeps yielding bytes, so a read bound by `size + 1` is exposed.
    async open(...args: Parameters<typeof actual.open>) {
      const stats = await actual.lstat(args[0])
      return {
        stat: async () => stats,
        close: async () => undefined,
        read: async (buffer: Buffer, offset: number, length: number) => {
          io.consumed += length
          buffer.fill(0, offset, offset + length)
          return { bytesRead: length, buffer }
        }
      }
    }
  }
})
let directory: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-agy-vault-read-'))
  io.consumed = 0
  setSecretStore({
    isEncryptionAvailable: () => true,
    describeProtectionGap: () => null,
    encryptString: (value) => Buffer.from(value),
    decryptString: () => {
      throw new Error('must reject before decrypting')
    }
  })
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
  _resetSecretStoreForTests()
})
it('caps a WSL vault read at 4 MiB when the file grows past its checked size', async () => {
  const path = join(directory, 'vault')
  await writeFile(path, Buffer.alloc(MAX_VAULT_BYTES), { mode: 0o600 })
  await chmod(path, 0o600)
  const authority = {
    distro: 'Ubuntu',
    uid: 1000,
    home: '/home/u',
    canonicalHome: '/home/u',
    authorityId: 'a'.repeat(64),
    credentialPath: '/home/u/token'
  }
  await expect(createEncryptedAntigravityAccountStore(path, { authority }).read()).rejects.toThrow(
    'preserved'
  )
  expect(io.consumed).toBeGreaterThan(0)
  expect(io.consumed).toBeLessThanOrEqual(MAX_VAULT_BYTES)
})
