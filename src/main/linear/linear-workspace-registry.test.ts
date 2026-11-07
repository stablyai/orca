import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type * as Os from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

let directory = ''
afterEach(() => {
  vi.doUnmock('os')
  vi.resetModules()
  rmSync(directory, { recursive: true, force: true })
})

describe('Linear workspace credential cache reset', () => {
  it('clears warmed credentials without reading real account files', async () => {
    directory = mkdtempSync(join(tmpdir(), 'orca-workspace-token-cache-'))
    vi.resetModules()
    vi.doMock('os', async () => {
      const actual = await vi.importActual<typeof Os>('os')
      return { ...actual, homedir: () => directory }
    })
    const { setSecretStore } = await import('../../shared/secret-store')
    setSecretStore({
      isEncryptionAvailable: () => false,
      encryptString: (value) => Buffer.from(value),
      decryptString: (value) => value.toString('utf-8'),
      describeProtectionGap: () => null
    })
    const tokenDirectory = join(directory, '.orca', 'linear-tokens')
    mkdirSync(tokenDirectory, { recursive: true })
    writeFileSync(
      join(tokenDirectory, `${Buffer.from('workspace').toString('base64url')}.enc`),
      'token'
    )
    const { workspaceTokenFileCache, resetCredentialCaches } =
      await import('./linear-workspace-registry')
    expect(workspaceTokenFileCache.read('workspace')).toBe('token')
    resetCredentialCaches()
    expect(workspaceTokenFileCache.read('workspace', false)).toBeNull()
  })
})
