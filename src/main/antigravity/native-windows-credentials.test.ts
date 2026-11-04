import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import type * as NodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createFakeWindowsSecurity,
  daclFromSddl,
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
import {
  createAntigravityWindowsCredentialBackend,
  readAntigravityWindowsCredential,
  readAntigravityWindowsCredentialContents,
  writeAntigravityWindowsCredential
} from './native-windows-credentials'
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
  it('keeps live container detection by default while isolating an explicit native fixture', async () => {
    fake.writeGenericCredential('gemini:antigravity', 'antigravity', Buffer.from(credential('a')))
    const nativeReads = vi.spyOn(fake, 'readGenericCredential')
    const fileReads = vi.spyOn(fake, 'readFileWithDacl')
    const defaultBackend = createAntigravityWindowsCredentialBackend(home)
    vi.mocked(existsSync).mockReturnValueOnce(true)
    expect(await defaultBackend.read()).toBeNull()
    expect(nativeReads).not.toHaveBeenCalled()
    const nativeBackend = createAntigravityWindowsCredentialBackend(home, () => false)
    expect((await nativeBackend.read())?.contents).toBe(credential('a'))
    vi.mocked(existsSync).mockReturnValueOnce(true)
    expect(await defaultBackend.read()).toBeNull()
    expect(nativeReads).toHaveBeenCalledTimes(1)
    expect(fileReads).toHaveBeenCalledTimes(2)
    expect(
      vi.mocked(existsSync).mock.calls.filter(([path]) => path === '/.dockerenv')
    ).toHaveLength(2)
  })

  function privateFile(contents: string) {
    const path = join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token')
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, contents)
    fake.dacls.set(path, hardenedDaclSddl(FAKE_USER_SID, false))
    return path
  }

  it.each([
    '{"token":{"refresh_token":"fixture-only"},"auth_method":"consumer"}',
    '{"wif_provider":"fixture-only"}',
    '{}',
    'null',
    '{"auth_method":"consumer"}',
    '{"token":{}}',
    '{"token":7}'
  ])(
    'never selects an old file when authoritative native snapshot support fails: %s',
    async (raw) => {
      const backend = createAntigravityHostCredentialBackend('/ignored-HOME')
      const h = harness()
      const service = new AntigravityAccountService(h.store, backend)
      fake.writeGenericCredential('gemini:antigravity', 'antigravity', Buffer.from(credential('b')))
      const saved = await service.addCurrentAccount()
      const path = privateFile(credential('a'))
      fake.writeGenericCredential('gemini:antigravity', 'antigravity', Buffer.from(raw))
      const writes = vi.spyOn(fake, 'writeGenericCredential')
      const fileWrites = vi.spyOn(fake, 'createFileWithDacl')
      vi.mocked(h.store.write).mockClear()
      await expect(service.selectAccount(saved.accounts[0].id)).rejects.toThrow()
      await expect(service.addCurrentAccount()).rejects.toThrow()
      await expect(service.removeAccount(saved.accounts[0].id)).rejects.toThrow()
      await expect(new AntigravityAccountService(h.store, backend).listAccounts()).rejects.toThrow()
      expect(writes).not.toHaveBeenCalled()
      expect(fileWrites).not.toHaveBeenCalled()
      expect(h.store.write).not.toHaveBeenCalled()
      expect(readFileSync(path, 'utf8')).toBe(credential('a'))
      expect(
        new TextDecoder().decode(fake.readGenericCredential('gemini:antigravity') ?? undefined)
      ).toBe(raw)
      expect(h.getVault().selectedAccountId).toBeNull()
    }
  )

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

  it('does not infer agent fallback from local wrapper or full addon failures', async () => {
    privateFile(credential('a'))
    const fileReads = vi.spyOn(fake, 'readFileWithDacl')
    const backend = createAntigravityHostCredentialBackend('/ignored-HOME')
    fake.readGenericCredential = () => {
      throw new TypeError('fixture-local-capability')
    }
    await expect(backend.read()).rejects.toThrow('could not be read')
    expect(fileReads).not.toHaveBeenCalled()
    fake.readGenericCredential = () => {
      throw Object.assign(new Error('fixture-only'), { win32Code: 5 })
    }
    await expect(backend.read()).rejects.toThrow('could not be read')
    Reflect.deleteProperty(fake, 'readGenericCredential')
    await expect(backend.read()).rejects.toThrow('could not be read')
    expect(fileReads).not.toHaveBeenCalled()
    setWindowsSecurityForTests(null)
    await expect(backend.read()).rejects.toThrow('could not be read')
    expect(() => readAntigravityCredentialFile(join(home, 'missing'))).toThrow('read safely')
    expect(fileReads).not.toHaveBeenCalled()
  })

  it('does not create native after an OS read failure with no file, or hide recovery at readback', async () => {
    const backend = createAntigravityHostCredentialBackend('/ignored-HOME')
    const unavailable = () => {
      throw Object.assign(new Error('fixture-only'), { syscall: 'CredReadW', win32Code: 5 })
    }
    fake.readGenericCredential = unavailable
    const writes = vi.spyOn(fake, 'writeGenericCredential')
    await expect(backend.write(credential('b'), null)).rejects.toThrow('could not be read')
    expect(writes).not.toHaveBeenCalled()
    const path = privateFile(credential('a'))
    const create = fake.createFileWithDacl
    fake.createFileWithDacl = (...args) => {
      create(...args)
      fake.readGenericCredential = () => Buffer.from(credential('a'))
    }
    await expect(backend.write(credential('b'), credential('a'))).rejects.toThrow(
      'could not be verified'
    )
    expect(readFileSync(path, 'utf8')).toBe(credential('b'))
    expect((await backend.read())?.contents).toBe(credential('a'))
    expect(writes).not.toHaveBeenCalled()
  })

  it('uses counted raw UTF-8 bytes at the CLI target, preserves fields, and verifies writes', async () => {
    const write = vi.spyOn(fake, 'writeGenericCredential')
    await writeAntigravityWindowsCredential(credential('テスト'))
    expect(write).toHaveBeenCalledWith(
      'gemini:antigravity',
      'antigravity',
      Buffer.from(credential('テスト'))
    )
    expect((await readAntigravityWindowsCredential())?.contents).toBe(credential('テスト'))
    write.mockImplementationOnce(() => {})
    await expect(writeAntigravityWindowsCredential(credential('b'))).rejects.toThrow(
      'could not be verified'
    )
  })

  it('distinguishes genuine absence from unsupported legacy-empty and corrupt native values', async () => {
    expect(await readAntigravityWindowsCredential()).toBeNull()
    fake.writeGenericCredential(
      'gemini:antigravity',
      'antigravity',
      Buffer.from('{"auth_method":"consumer","token":null}')
    )
    await expect(readAntigravityWindowsCredential()).rejects.toThrow('could not be decoded')
    fake.writeGenericCredential('gemini:antigravity', 'antigravity', Buffer.from([255]))
    await expect(readAntigravityWindowsCredential()).rejects.toThrow('could not be decoded')
    fake.readGenericCredential = () => {
      throw new Error('fixture-secret')
    }
    await expect(readAntigravityWindowsCredential()).rejects.toThrow(
      /^The Antigravity Windows credential store could not be read\.$/
    )
    setWindowsSecurityForTests(null)
    await expect(readAntigravityWindowsCredential()).rejects.toThrow('could not be read')
  })

  it('rejects oversize UTF-8 credentials before touching the native store', async () => {
    const write = vi.spyOn(fake, 'writeGenericCredential')
    const contents = JSON.stringify({
      token: { access_token: 'テ'.repeat(900) },
      auth_method: 'consumer'
    })
    await expect(writeAntigravityWindowsCredential(contents)).rejects.toThrow('size limit')
    expect(write).not.toHaveBeenCalled()
  })

  it('creates native credentials when empty, preserves effective file fallback, and detects changes', async () => {
    const backend = createAntigravityHostCredentialBackend('/ignored-HOME')
    await backend.write(credential('a'), null)
    expect((await backend.read())?.contents).toBe(credential('a'))
    await expect(backend.write(credential('b'), null)).rejects.toThrow('changed during selection')
    const path = join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token')
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, credential('b'))
    const read = fake.readFileWithDacl
    fake.readFileWithDacl = (path, max) => {
      const file = read(path, max)
      return file ? { ...file, dacl: daclFromSddl(hardenedDaclSddl(FAKE_USER_SID, false)) } : null
    }
    expect((await backend.read())?.contents).toBe(credential('a'))
    fake.readGenericCredential = () => {
      throw Object.assign(new Error('native unavailable'), { syscall: 'CredReadW', win32Code: 5 })
    }
    await backend.write(credential('c'), credential('b'))
    expect(readFileSync(path, 'utf8')).toBe(credential('c'))
    expect((await backend.read())?.contents).toBe(credential('c'))
    fake.readGenericCredential = () => Buffer.from(credential('a'))
    expect((await backend.read())?.contents).toBe(credential('a'))
  })

  it('uses private file storage for Windows SSH bypass without native I/O', async () => {
    vi.stubEnv('SSH_CLIENT', 'fixture-host')
    fake.readGenericCredential = () => {
      throw new Error('must not use native')
    }
    const backend = createAntigravityHostCredentialBackend('/ignored-HOME')
    expect(await backend.read()).toBeNull()
    fake.readFileWithDacl = (path) =>
      existsSync(path)
        ? {
            data: readFileSync(path),
            dacl: daclFromSddl(hardenedDaclSddl(FAKE_USER_SID, false))
          }
        : null
    await backend.write(credential('a'), null)
    expect((await backend.read())?.contents).toBe(credential('a'))
    fake.createFileWithDacl = () => {
      throw new Error('fixture-secret Win32 error 5')
    }
    await expect(backend.write(credential('b'), credential('a'))).rejects.toThrow(
      /^Antigravity could not update its credential file privately\. Check the file permissions and try again\.$/
    )
    expect((await backend.read())?.contents).toBe(credential('a'))
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

  it('validates a carried requested snapshot before publishing a current refresh', async () => {
    const backend = createAntigravityHostCredentialBackend('/ignored-HOME')
    const h = harness()
    const service = new AntigravityAccountService(h.store, backend)
    fake.writeGenericCredential('gemini:antigravity', 'antigravity', Buffer.from(credential('a')))
    await service.addCurrentAccount()
    const carried = h.getVault()
    carried.accounts.push({
      ...carried.accounts[0],
      id: 'carried',
      subject: 'b',
      credentials: '{"token":{"access_token":"b","expiry":7},"access_token":7}'
    })
    h.store.write(carried)
    fake.writeGenericCredential(
      'gemini:antigravity',
      'antigravity',
      Buffer.from(credential('a', 2))
    )
    const writes = vi.spyOn(fake, 'writeGenericCredential')
    const fileWrites = vi.spyOn(fake, 'createFileWithDacl')
    vi.mocked(h.store.write).mockClear()
    await expect(service.selectAccount('carried')).rejects.toThrow('could not be decoded')
    expect(writes).not.toHaveBeenCalled()
    expect(fileWrites).not.toHaveBeenCalled()
    expect(h.store.write).not.toHaveBeenCalled()
    expect(h.getVault()).toEqual(carried)
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

  it('re-derives the destination when native recovers with the same effective bytes', async () => {
    const backend = createAntigravityHostCredentialBackend('/ignored-HOME')
    privateFile(credential('a'))
    fake.writeGenericCredential('gemini:antigravity', 'antigravity', Buffer.from(credential('a')))
    const read = vi.spyOn(fake, 'readGenericCredential')
    read.mockImplementationOnce(() => {
      throw Object.assign(new Error('fixture-only'), { syscall: 'CredReadW', win32Code: 5 })
    })
    const expected = (await backend.read())?.contents ?? null
    const writes = vi.spyOn(fake, 'writeGenericCredential')
    const fileWrites = vi.spyOn(fake, 'createFileWithDacl')
    await backend.write(credential('b'), expected)
    expect(writes).toHaveBeenCalledTimes(1)
    expect(fileWrites).not.toHaveBeenCalled()
    expect((await backend.read())?.contents).toBe(credential('b'))
    await expect(backend.write(credential('c'), credential('a'))).rejects.toThrow(
      'changed during selection'
    )
    expect(writes).toHaveBeenCalledTimes(1)
  })
  it('rejects lossy native snapshots without changing an existing selection or any store', async () => {
    const backend = createAntigravityHostCredentialBackend('/ignored-HOME')
    const h = harness()
    const service = new AntigravityAccountService(h.store, backend)
    fake.writeGenericCredential('gemini:antigravity', 'antigravity', Buffer.from(credential('b')))
    const id = (await service.addCurrentAccount()).accounts[0].id
    await service.selectAccount(id)
    privateFile(credential('a'))
    fake.writeGenericCredential(
      'gemini:antigravity',
      'antigravity',
      Buffer.concat([
        Buffer.from('{"token":{"access_token":"'),
        Buffer.from([255]),
        Buffer.from('"}}')
      ])
    )
    const writes = vi.spyOn(fake, 'writeGenericCredential')
    const fileWrites = vi.spyOn(fake, 'createFileWithDacl')
    vi.mocked(h.store.write).mockClear()
    await expect(service.selectAccount(id)).rejects.toThrow('losslessly')
    await expect(new AntigravityAccountService(h.store, backend).listAccounts()).rejects.toThrow(
      'losslessly'
    )
    expect(writes).not.toHaveBeenCalled()
    expect(fileWrites).not.toHaveBeenCalled()
    expect(h.store.write).not.toHaveBeenCalled()
    expect(h.getVault().selectedAccountId).toBe(id)
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
