import type * as NodeFs from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { credential } from './native-account-test-fixtures'
import {
  createAntigravityFileCredentialBackend,
  createAntigravityHostCredentialBackend,
  isAntigravityFileStorageHost
} from './native-credential-backend'

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof NodeFs>('node:fs')
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) =>
      args[0] === '/proc/sys/kernel/osrelease' ? '6.8-linux' : actual.readFileSync(...args)
  }
})

vi.mock('./native-macos-credentials', () => ({
  readAntigravityMacOSCredential: vi.fn(),
  writeAntigravityMacOSCredential: vi.fn()
}))
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('execution-host native credential authority', () => {
  it('performs a real isolated file write/readback and detects a stale before-write credential', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-agy-backend-test-'))
    try {
      const path = join(dir, '.gemini', 'antigravity-cli', 'antigravity-oauth-token')
      const backend = createAntigravityFileCredentialBackend(path)
      await backend.write(credential('a'), null)
      expect((await backend.read())?.identity?.subject).toBe('a')
      await backend.write(credential('b'), credential('a'))
      expect(readFileSync(path, 'utf8')).toBe(credential('b'))
      await expect(backend.write(credential('a'), credential('a'))).rejects.toThrow(
        'changed during selection'
      )
      expect(readFileSync(path, 'utf8')).toBe(credential('b'))
      if (process.platform !== 'win32') {
        expect(statSync(path).mode & 0o077).toBe(0)
        chmodSync(path, 0o644)
        await expect(backend.read()).rejects.toThrow('read safely')
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it.each(['SSH_TTY', 'SSH_CLIENT', 'SSH_CONNECTION', 'WSL_DISTRO_NAME', 'WSL_INTEROP'])(
    'uses the owning-host file bypass detector %s',
    (key) => {
      expect(isAntigravityFileStorageHost({ [key]: 'present' })).toBe(true)
      expect(isAntigravityFileStorageHost({ [key]: '' })).toBe(false)
    }
  )

  it('recognizes WSL kernel evidence and never guesses file mode from Linux alone', () => {
    expect(isAntigravityFileStorageHost({}, '6.6-microsoft-standard-WSL2')).toBe(true)
    expect(isAntigravityFileStorageHost({}, '6.8-linux')).toBe(false)
  })

  it('refuses Windows file bypass until private ACL protection is verified', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    vi.stubEnv('SSH_CLIENT', 'task-host')
    expect(() => createAntigravityHostCredentialBackend('/task-home')).toThrow(
      'private file permissions need a verified adapter'
    )
  })

  it.each(['win32', 'linux'] as const)(
    'capability-refuses unverified native %s without mutating client credentials',
    (platform) => {
      for (const key of [
        'SSH_TTY',
        'SSH_CLIENT',
        'SSH_CONNECTION',
        'WSL_DISTRO_NAME',
        'WSL_INTEROP'
      ]) {
        vi.stubEnv(key, '')
      }
      vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
      expect(() => createAntigravityHostCredentialBackend('/task-home')).toThrow(
        'not supported on this host yet'
      )
    }
  )
})
