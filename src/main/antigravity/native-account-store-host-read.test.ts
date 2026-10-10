import type * as NodeFs from 'node:fs'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { _resetSecretStoreForTests, setSecretStore } from '../../shared/secret-store'
import { createEncryptedAntigravityAccountStore } from './native-account-store'

const MAX_VAULT_BYTES = 4 * 1024 * 1024
const io = vi.hoisted(() => ({ consumed: 0, reportedSize: 0 }))
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof NodeFs>('node:fs')
  return {
    ...actual,
    // Model a vault that grew past its checked size after the stat: metadata reports the checked
    // size while the file keeps yielding bytes, so an unbounded read is exposed.
    lstatSync: (path: NodeFs.PathLike) =>
      Object.assign(actual.lstatSync(path), { size: io.reportedSize }),
    fstatSync: (descriptor: number) =>
      Object.assign(actual.fstatSync(descriptor), { size: io.reportedSize }),
    readFileSync: (path: NodeFs.PathLike) => {
      const bytes = actual.readFileSync(path)
      io.consumed += bytes.length
      return bytes
    },
    readSync: (
      descriptor: number,
      buffer: NodeJS.ArrayBufferView,
      offset: number,
      length: number,
      position: number | null
    ) => {
      const bytesRead = actual.readSync(descriptor, buffer, offset, length, position)
      io.consumed += bytesRead
      return bytesRead
    }
  }
})
let directory: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-agy-host-vault-'))
  io.consumed = 0
  io.reportedSize = MAX_VAULT_BYTES
  setSecretStore({
    isEncryptionAvailable: () => true,
    describeProtectionGap: () => null,
    encryptString: (value) => Buffer.from(value),
    decryptString: () => {
      throw new Error('must reject before decrypting')
    }
  })
})
afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
  _resetSecretStoreForTests()
})
it('caps a host vault read at 4 MiB when the file grows past its checked size', () => {
  const path = join(directory, 'vault')
  writeFileSync(path, Buffer.alloc(MAX_VAULT_BYTES + 128), { mode: 0o600 })
  chmodSync(path, 0o600)
  expect(() => createEncryptedAntigravityAccountStore(path).read()).toThrow('preserved')
  expect(io.consumed).toBeGreaterThan(0)
  expect(io.consumed).toBeLessThanOrEqual(MAX_VAULT_BYTES)
})
