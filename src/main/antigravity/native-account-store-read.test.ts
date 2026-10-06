import type * as NodeFsPromises from 'node:fs/promises'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { setSecretStore, _resetSecretStoreForTests } from '../../shared/secret-store'
import { createEncryptedAntigravityAccountStore } from './native-account-store'

const io = vi.hoisted(() => ({ smallStat: false, consumed: 0 }))
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof NodeFsPromises>('node:fs/promises')
  return {
    ...actual,
    async lstat(...args: Parameters<typeof actual.lstat>) {
      const stat = await actual.lstat(...args)
      if (io.smallStat) {
        stat.size = 1
      }
      return stat
    },
    async readFile(...args: Parameters<typeof actual.readFile>) {
      const bytes = await actual.readFile(...args)
      io.consumed += Buffer.byteLength(bytes)
      return bytes
    }
  }
})
let directory: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-agy-vault-read-'))
  io.smallStat = false
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
it('bounds reads when a WSL vault grows after the first path stat', async () => {
  const path = join(directory, 'vault')
  await writeFile(path, Buffer.alloc(4 * 1024 * 1024 + 128), { mode: 0o600 })
  await chmod(path, 0o600)
  io.smallStat = true
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
  expect(io.consumed).toBeLessThanOrEqual(4 * 1024 * 1024 + 1)
})
