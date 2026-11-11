import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import type * as NodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createFakeWindowsSecurity,
  FAKE_USER_SID,
  type FakeWindowsSecurity
} from '../../shared/windows-security-addon.test-fixture'
import {
  setWindowsSecurityForTests,
  resetWindowsSecurityLoadForTests
} from '../../shared/windows-security-addon'
import { hardenedDaclSddl } from '../../shared/windows-secure-dacl'
import { credential, harness } from './native-account-test-fixtures'
import { AntigravityAccountService } from './native-account-service'
import { createAntigravityHostCredentialBackend } from './native-credential-backend'
import { readAntigravityWindowsCredentialContents } from './native-windows-credentials'
import { readAntigravityCredentialFile } from './native-file-credentials'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  return { ...actual, existsSync: vi.fn(actual.existsSync) }
})

let home: string
let fake: FakeWindowsSecurity
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orca-agy-windows-'))
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  for (const key of ['SSH_TTY', 'SSH_CLIENT', 'SSH_CONNECTION', 'WSL_DISTRO_NAME', 'WSL_INTEROP']) {
    vi.stubEnv(key, '')
  }
  vi.stubEnv('USERPROFILE', home)
  fake = createFakeWindowsSecurity()
  setWindowsSecurityForTests(fake)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.mocked(existsSync).mockReset()
  vi.unstubAllEnvs()
  resetWindowsSecurityLoadForTests()
  rmSync(home, { recursive: true, force: true })
})

describe('Windows native Antigravity credentials', () => {
  function privateFile(contents: string) {
    const path = join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token')
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, contents)
    fake.dacls.set(path, hardenedDaclSddl(FAKE_USER_SID, false))
    return path
  }

  it('retains BOM identity at both raw boundaries and refuses normalization before mutation', async () => {
    const raw = `\uFEFF${credential('a')}`
    fake.writeGenericCredential('gemini:antigravity', 'antigravity', Buffer.from(raw))
    const path = privateFile(raw)
    expect(await readAntigravityWindowsCredentialContents()).toBe(raw)
    expect(readAntigravityCredentialFile(path)).toBe(raw)
    const writes = vi.spyOn(fake, 'writeGenericCredential')
    const backend = createAntigravityHostCredentialBackend('/ignored-HOME')
    await expect(backend.write(credential('b'), credential('a'))).rejects.toThrow()
    vi.stubEnv('SSH_CLIENT', 'fixture-only')
    await expect(backend.write(credential('b'), credential('a'))).rejects.toThrow('read safely')
    expect(writes).not.toHaveBeenCalled()
    expect(readFileSync(path)).toEqual(Buffer.from(raw))
    fake.writeGenericCredential('gemini:antigravity', 'antigravity', Buffer.from([255]))
    await expect(readAntigravityWindowsCredentialContents()).rejects.toThrow('could not be read')
    writeFileSync(path, Buffer.from([255]))
    expect(() => readAntigravityCredentialFile(path)).toThrow('read safely')
  })

  it.each([
    '{"access_token":7}',
    '{"token":{"access_token":"wrong"},"project_id":17,"expires_in":"x"}',
    '\ufeff{"access_token":"wrong"}'
  ])('uses the actual effective file after both native decodes reject: %s', async (raw) => {
    const backend = createAntigravityHostCredentialBackend('/ignored-HOME')
    const h = harness()
    const service = new AntigravityAccountService(h.store, backend)
    fake.writeGenericCredential('gemini:antigravity', 'antigravity', Buffer.from(credential('b')))
    const id = (await service.addCurrentAccount()).accounts[0].id
    const path = privateFile(credential('a'))
    fake.writeGenericCredential('gemini:antigravity', 'antigravity', Buffer.from(raw))
    const writes = vi.spyOn(fake, 'writeGenericCredential')
    const fileWrites = vi.spyOn(fake, 'createFileWithDacl')
    vi.mocked(h.store.write).mockClear()
    expect((await service.selectAccount(id)).selectedAccountId).toBe(id)
    expect(readFileSync(path, 'utf8')).toBe(credential('b'))
    expect(writes).not.toHaveBeenCalled()
    expect(fileWrites).toHaveBeenCalledTimes(1)
    expect(h.store.write).toHaveBeenCalledTimes(1)
    expect(
      (await new AntigravityAccountService(h.store, backend).listAccounts()).activeAccountId
    ).toBe(id)
  })

  it('does not publish selection when recovered native authority shadows a file write', async () => {
    const backend = createAntigravityHostCredentialBackend('/ignored-HOME')
    const h = harness()
    const service = new AntigravityAccountService(h.store, backend)
    fake.writeGenericCredential('gemini:antigravity', 'antigravity', Buffer.from(credential('b')))
    const id = (await service.addCurrentAccount()).accounts[0].id
    const path = privateFile(credential('a'))
    fake.readGenericCredential = () => {
      throw Object.assign(new Error('fixture-only'), { syscall: 'CredReadW', win32Code: 5 })
    }
    const create = fake.createFileWithDacl
    fake.createFileWithDacl = (...args) => {
      create(...args)
      fake.readGenericCredential = () => Buffer.from(credential('a'))
    }
    const writes = vi.spyOn(fake, 'writeGenericCredential')
    const fileWrites = vi.spyOn(fake, 'createFileWithDacl')
    vi.mocked(h.store.write).mockClear()
    await expect(service.selectAccount(id)).rejects.toThrow('could not be verified')
    expect(writes).not.toHaveBeenCalled()
    expect(fileWrites).toHaveBeenCalledTimes(1)
    expect(h.store.write).not.toHaveBeenCalled()
    expect(h.getVault().selectedAccountId).toBeNull()
    expect(readFileSync(path, 'utf8')).toBe(credential('b'))
    const restarted = new AntigravityAccountService(h.store, backend)
    expect((await restarted.listAccounts()).activeAccountId).toBeNull()
  })

  it('never fabricates absence from decoder rejection and refuses an unsafe effective file', async () => {
    const backend = createAntigravityHostCredentialBackend('/ignored-HOME')
    fake.writeGenericCredential(
      'gemini:antigravity',
      'antigravity',
      Buffer.from('{"access_token":7}')
    )
    const writes = vi.spyOn(fake, 'writeGenericCredential')
    const fileWrites = vi.spyOn(fake, 'createFileWithDacl')
    await expect(backend.write(credential('a'), null)).rejects.toThrow('could not be decoded')
    const path = privateFile(credential('a'))
    fake.dacls.set(path, 'D:(A;;FA;;;WD)')
    await expect(backend.write(credential('b'), credential('a'))).rejects.toThrow('read safely')
    expect(writes).not.toHaveBeenCalled()
    expect(fileWrites).not.toHaveBeenCalled()
    expect(readFileSync(path, 'utf8')).toBe(credential('a'))
  })
})
