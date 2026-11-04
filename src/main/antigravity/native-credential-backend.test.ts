import { describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { credential } from './native-account-test-fixtures'
import { createAntigravityFileCredentialBackend } from './native-credential-backend'

vi.mock('./native-macos-credentials', () => ({
  readAntigravityMacOSCredential: vi.fn(),
  writeAntigravityMacOSCredential: vi.fn()
}))

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
})
