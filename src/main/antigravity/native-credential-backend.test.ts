import { describe, expect, it, vi } from 'vitest'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { credential } from './native-account-test-fixtures'
import {
  createAntigravityFileCredentialBackend,
  createAntigravityHostCredentialBackend
} from './native-credential-backend'
import { hasAntigravityLinuxSecretService } from './native-linux-credentials'

vi.mock('./native-macos-credentials', () => ({
  readAntigravityMacOSCredential: vi.fn(),
  writeAntigravityMacOSCredential: vi.fn()
}))

vi.mock('./native-linux-credentials', () => ({
  readAntigravityLinuxCredential: vi.fn(async () => null),
  writeAntigravityLinuxCredential: vi.fn(),
  hasAntigravityLinuxSecretService: vi.fn(async () => false)
}))

import type * as NativeFileCredentials from './native-file-credentials'

vi.mock('./native-file-credentials', async (importActual) => {
  const actual = await importActual<typeof NativeFileCredentials>()
  return {
    ...actual,
    isAntigravityContainerOrWslHost: vi.fn(() => false)
  }
})

import { isAntigravityContainerOrWslHost } from './native-file-credentials'

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

  it('uses file fallback on headless Linux when Secret Service is unavailable despite the fallback marker', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-agy-headless-linux-'))
    const originalEnv = process.env
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    process.env = { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' }
    vi.mocked(isAntigravityContainerOrWslHost).mockReturnValue(false)
    try {
      const root = join(dir, '.gemini', 'antigravity-cli')
      mkdirSync(join(root, 'cache'), { recursive: true })
      const tokenPath = join(root, 'antigravity-oauth-token')
      writeFileSync(tokenPath, credential('a'), { mode: 0o600 })
      writeFileSync(join(root, 'cache', 'antigravity-keyring-unavailable'), '1')

      vi.mocked(hasAntigravityLinuxSecretService).mockResolvedValue(false)

      const backend = createAntigravityHostCredentialBackend(dir)
      expect((await backend.read())?.identity?.subject).toBe('a')
      await backend.write(credential('b'), credential('a'))
      expect(readFileSync(tokenPath, 'utf8')).toBe(credential('b'))

      // When Secret Service IS reachable, the fallback marker remains ambiguous and must throw.
      vi.mocked(hasAntigravityLinuxSecretService).mockResolvedValue(true)
      await expect(backend.read()).rejects.toThrow('fallback marker')

      // Container/WSL hosts intentionally select the file backend before marker/Secret Service checks.
      vi.mocked(isAntigravityContainerOrWslHost).mockReturnValue(true)
      expect((await createAntigravityHostCredentialBackend(dir).read())?.identity?.subject).toBe(
        'b'
      )
    } finally {
      vi.mocked(isAntigravityContainerOrWslHost).mockReturnValue(false)
      process.env = originalEnv
      platformSpy.mockRestore()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
