import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  enrollIsolatedClaudeAccount,
  hasIsolatedClaudeAccountAuth,
  readClaudeAccountCredentials,
  writeClaudeAccountCredentials
} from './isolated-account-auth'
import { withClaudeManagedPreviewKeychainCredentials } from '../rate-limits/claude-managed-account-credentials'
import { ClaudeManagedAuthStorage } from './claude-managed-auth-storage'

const state = vi.hoisted(() => ({
  userData: '',
  privateEntries: new Map<string, string>(),
  scopedEntries: new Map<string, string>(),
  failWrite: false
}))
vi.mock('electron', () => ({ app: { getPath: () => state.userData } }))
vi.mock('./keychain', () => ({
  readManagedClaudeKeychainCredentials: async (id: string) => state.privateEntries.get(id) ?? null,
  writeManagedClaudeKeychainCredentials: async (id: string, value: string) => {
    state.privateEntries.set(id, value)
  },
  readActiveClaudeKeychainCredentialsStrict: async (directory: string) =>
    state.scopedEntries.get(directory) ?? null,
  writeActiveClaudeKeychainCredentials: async (value: string, directory: string) => {
    if (state.failWrite) {
      throw new Error('Keychain unavailable')
    }
    state.scopedEntries.set(directory, value)
  },
  deleteActiveClaudeKeychainCredentialsStrict: async (directory: string) => {
    state.scopedEntries.delete(directory)
  },
  deleteManagedClaudeKeychainCredentials: async (id: string) => {
    state.privateEntries.delete(id)
  }
}))

function account(id: string) {
  const directory = join(state.userData, 'claude-accounts', id, 'auth')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, '.orca-managed-claude-auth'), `${id}\n`)
  state.privateEntries.set(id, `${id}-original`)
  return { accountId: id, managedAuthPath: directory }
}

describe('canonical isolated Claude credentials', () => {
  beforeEach(() => {
    installFakeAppEnvironment({ getPath: () => state.userData })
    state.userData = mkdtempSync(join(tmpdir(), 'orca-profile-auth-'))
    state.privateEntries.clear()
    state.scopedEntries.clear()
    state.failWrite = false
  })
  afterEach(() => rmSync(state.userData, { recursive: true, force: true }))

  it('keeps A and B in distinct scoped namespaces and shares A across callers', async () => {
    const a = account('a')
    const b = account('b')
    await Promise.all(
      [a, b].map((location) =>
        enrollIsolatedClaudeAccount(
          location,
          { oauthAccount: { emailAddress: `${location.accountId}@example.com` } },
          'darwin'
        )
      )
    )
    await writeClaudeAccountCredentials(a, 'a-refreshed', 'darwin')
    expect(await readClaudeAccountCredentials(a, 'darwin')).toBe('a-refreshed')
    expect(await readClaudeAccountCredentials(b, 'darwin')).toBe('b-original')
    expect([...state.scopedEntries.keys()].sort()).toEqual(
      [a.managedAuthPath, b.managedAuthPath].sort()
    )
    expect(state.privateEntries.get('a')).toBe('a-original')
  })

  it('never restores the stale private token after the canonical credential disappears', async () => {
    const a = account('a')
    await enrollIsolatedClaudeAccount(a, { oauthAccount: null }, 'darwin')
    state.scopedEntries.delete(a.managedAuthPath)
    expect(await readClaudeAccountCredentials(a, 'darwin')).toBeNull()
    await expect(enrollIsolatedClaudeAccount(a, { oauthAccount: null }, 'darwin')).rejects.toThrow(
      'credential'
    )
  })

  it('rejects a broken enrollment marker instead of falling back to private credentials', async () => {
    const a = account('a')
    symlinkSync(
      join(a.managedAuthPath, 'missing'),
      join(a.managedAuthPath, '.orca-claude-isolated-auth')
    )
    await expect(readClaudeAccountCredentials(a, 'darwin')).rejects.toThrow('marker')
  })

  it('leaves legacy authority usable when scoped storage fails', async () => {
    const a = account('a')
    state.failWrite = true
    await expect(enrollIsolatedClaudeAccount(a, { oauthAccount: null }, 'darwin')).rejects.toThrow(
      'Keychain unavailable'
    )
    expect(hasIsolatedClaudeAccountAuth(a.managedAuthPath)).toBe(false)
    expect(await readClaudeAccountCredentials(a, 'darwin')).toBe('a-original')
  })

  it('uses the existing Linux account credential file without making a token copy', async () => {
    const a = account('a')
    writeFileSync(join(a.managedAuthPath, '.credentials.json'), 'linux-token')
    await enrollIsolatedClaudeAccount(
      a,
      { oauthAccount: { emailAddress: 'a@example.com' } },
      'linux'
    )
    expect(await readClaudeAccountCredentials(a, 'linux')).toBe('linux-token')
    const config = JSON.parse(readFileSync(join(a.managedAuthPath, '.claude.json'), 'utf8'))
    expect(config.oauthAccount.emailAddress).toBe('a@example.com')
    expect(state.scopedEntries.size).toBe(0)
  })

  it('rejects a directory belonging to another account before writing credentials', async () => {
    const a = account('a')
    await expect(
      enrollIsolatedClaudeAccount({ ...a, accountId: 'b' }, { oauthAccount: null }, 'darwin')
    ).rejects.toThrow('owned')
    expect(state.scopedEntries.size).toBe(0)
  })

  it('a usage-panel probe neither overwrites nor deletes the canonical credential', async () => {
    const a = account('a')
    await enrollIsolatedClaudeAccount(a, { oauthAccount: null }, 'darwin')
    await writeClaudeAccountCredentials(a, 'rotated-by-cli', 'darwin')
    await withClaudeManagedPreviewKeychainCredentials(
      { kind: 'keychain', ...a },
      'stale-preview-token',
      async () => {
        expect(await readClaudeAccountCredentials(a, 'darwin')).toBe('rotated-by-cli')
      }
    )
    expect(await readClaudeAccountCredentials(a, 'darwin')).toBe('rotated-by-cli')
  })

  it.each(['darwin', 'linux'] as const)(
    'keeps isolated live grants across write and rollback on %s',
    async (platform) => {
      const previousPlatform = process.platform
      Object.defineProperty(process, 'platform', { value: platform, configurable: true })
      try {
        const a = account('a')
        const oauth = { claudeAiOauth: { accessToken: 'synthetic' } }
        const legacy = JSON.stringify({ ...oauth, mcpOAuth: { oldSharedGrant: 'old' } })
        state.privateEntries.set('a', legacy)
        writeFileSync(join(a.managedAuthPath, '.credentials.json'), legacy)
        await enrollIsolatedClaudeAccount(a, { oauthAccount: null }, platform)
        expect(JSON.parse((await readClaudeAccountCredentials(a, platform))!)).toEqual(oauth)
        const storage = new ClaudeManagedAuthStorage()
        const own = JSON.stringify({
          ...oauth,
          mcpOAuth: { own: 'grant' },
          pluginSecrets: { own: 'secret' }
        })
        await storage.writeCredentials('a', a.managedAuthPath, own)
        const snapshot = await storage.readSnapshot('a', a.managedAuthPath)
        expect(snapshot.credentialsJson).toBe(own)
        await storage.writeCredentials('a', a.managedAuthPath, JSON.stringify(oauth))
        await storage.restoreCredentials('a', a.managedAuthPath, snapshot)
        expect(await readClaudeAccountCredentials(a, platform)).toBe(own)
      } finally {
        Object.defineProperty(process, 'platform', { value: previousPlatform, configurable: true })
      }
    }
  )

  it('rolls back canonical credentials and CLI identity after failed reauthentication', async () => {
    const a = account('a')
    writeFileSync(join(a.managedAuthPath, '.credentials.json'), 'original')
    const storage = new ClaudeManagedAuthStorage()
    await storage.writeOauthAccount('a', a.managedAuthPath, {
      emailAddress: 'original@example.com'
    })
    await enrollIsolatedClaudeAccount(
      a,
      { oauthAccount: { emailAddress: 'original@example.com' } },
      'linux'
    )
    const snapshot = await storage.readSnapshot('a', a.managedAuthPath)
    await storage.writeAuth('a', a.managedAuthPath, {
      credentialsJson: 'wrong-account',
      oauthAccount: { emailAddress: 'wrong@example.com' }
    })
    await storage.restoreCredentials('a', a.managedAuthPath, snapshot)
    await storage.restoreOauth('a', a.managedAuthPath, snapshot)
    expect(await readClaudeAccountCredentials(a, 'linux')).toBe('original')
    expect(
      JSON.parse(readFileSync(join(a.managedAuthPath, '.claude.json'), 'utf8')).oauthAccount
        .emailAddress
    ).toBe('original@example.com')
  })
})
