import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ClaudeManagedAccount } from '../../shared/managed-account-types'
import {
  readActiveClaudeKeychainCredentialsStrict,
  writeManagedClaudeKeychainCredentials
} from './keychain'
import { restorePlatform, setPlatform } from './claude-account-service-test-harness'

const CLAUDE_SERVICE_TEST_ROOT = join(tmpdir(), 'orca-claude-service-config-dir-test')

vi.mock('electron', () => ({
  app: {
    getPath: () => CLAUDE_SERVICE_TEST_ROOT
  }
}))

const commandMocks = vi.hoisted(() => ({
  resolveClaudeCommand: vi.fn(() => 'claude')
}))

vi.mock('../codex-cli/command', () => ({
  resolveClaudeCommand: commandMocks.resolveClaudeCommand
}))

vi.mock('./keychain', () => ({
  deleteActiveClaudeKeychainCredentialsStrict: vi.fn(async () => {}),
  deleteManagedClaudeKeychainCredentials: vi.fn(async () => {}),
  readActiveClaudeKeychainCredentials: vi.fn(),
  readActiveClaudeKeychainCredentialsStrict: vi.fn(),
  readManagedClaudeKeychainCredentials: vi.fn(),
  writeActiveClaudeKeychainCredentials: vi.fn(async () => {}),
  writeManagedClaudeKeychainCredentials: vi.fn(async () => {})
}))

describe('ClaudeAccountService.addAccountFromConfigDir', () => {
  const managedRoot = CLAUDE_SERVICE_TEST_ROOT
  let sourceDir: string | null = null

  beforeEach(() => {
    setPlatform('linux')
    rmSync(managedRoot, { recursive: true, force: true })
    sourceDir = null
    vi.mocked(readActiveClaudeKeychainCredentialsStrict).mockReset()
    vi.mocked(writeManagedClaudeKeychainCredentials).mockReset().mockResolvedValue()
  })

  afterEach(() => {
    restorePlatform()
    rmSync(managedRoot, { recursive: true, force: true })
    if (sourceDir) {
      rmSync(sourceDir, { recursive: true, force: true })
    }
  })

  function makeDeps() {
    let settings = {
      claudeManagedAccounts: [] as ClaudeManagedAccount[],
      activeClaudeManagedAccountId: null as string | null,
      activeClaudeManagedAccountIdsByRuntime: { host: null as string | null, wsl: {} }
    }
    const store = {
      getSettings: vi.fn(() => settings),
      updateSettings: vi.fn((updates: Partial<typeof settings>) => {
        settings = { ...settings, ...updates }
        return settings
      })
    }
    const rateLimits = { evictInactiveClaudeCache: vi.fn() }
    const runtimeAuth = {
      clearLastWrittenCredentialsJson: vi.fn(),
      forceMaterializeCurrentSelectionForRollback: vi.fn(async () => {})
    }
    return { store, rateLimits, runtimeAuth, getSettings: () => settings }
  }

  it('registers a managed account by capturing an authenticated config dir', async () => {
    sourceDir = mkdtempSync(join(tmpdir(), 'orca-claude-source-'))
    writeFileSync(
      join(sourceDir, '.credentials.json'),
      '{"claudeAiOauth":{"accessToken":"tok"}}\n',
      'utf-8'
    )
    writeFileSync(
      join(sourceDir, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'new@example.com' } }),
      'utf-8'
    )

    const deps = makeDeps()
    const { ClaudeAccountService } = await import('./service')
    const service = new ClaudeAccountService(
      deps.store as never,
      deps.rateLimits as never,
      deps.runtimeAuth as never
    )
    // Why: avoid spawning a real `claude auth status` subprocess in the test.
    ;(service as unknown as { runClaudeCommand: () => Promise<string> }).runClaudeCommand = vi.fn(
      async () => '{"email":"new@example.com"}'
    )

    const result = await service.addAccountFromConfigDir(sourceDir)

    const accounts = deps.getSettings().claudeManagedAccounts
    expect(accounts).toHaveLength(1)
    expect(accounts[0].email).toBe('new@example.com')
    expect(result.accounts[0]?.email).toBe('new@example.com')
    expect(readFileSync(join(accounts[0].managedAuthPath, '.credentials.json'), 'utf-8')).toBe(
      '{"claudeAiOauth":{"accessToken":"tok"}}\n'
    )
    expect(deps.runtimeAuth.clearLastWrittenCredentialsJson).toHaveBeenCalledWith(accounts[0].id)
  })

  it('captures only the config-scoped macOS Keychain credential', async () => {
    setPlatform('darwin')
    sourceDir = mkdtempSync(join(tmpdir(), 'orca-claude-source-keychain-'))
    vi.mocked(readActiveClaudeKeychainCredentialsStrict).mockImplementation(async (configDir) =>
      configDir ? '{"claudeAiOauth":{"accessToken":"scoped"}}' : 'legacy-credentials'
    )
    const deps = makeDeps()
    const { ClaudeAccountService } = await import('./service')
    const service = new ClaudeAccountService(
      deps.store as never,
      deps.rateLimits as never,
      deps.runtimeAuth as never
    )
    ;(service as unknown as { runClaudeCommand: () => Promise<string> }).runClaudeCommand = vi.fn(
      async () => '{"email":"new@example.com"}'
    )

    await service.addAccountFromConfigDir(sourceDir)

    expect(readActiveClaudeKeychainCredentialsStrict).toHaveBeenCalledWith(sourceDir)
    expect(writeManagedClaudeKeychainCredentials).toHaveBeenCalledWith(
      expect.any(String),
      '{"claudeAiOauth":{"accessToken":"scoped"}}'
    )
  })

  it('does not mistake an unchanged legacy Keychain credential for the temp login', async () => {
    setPlatform('darwin')
    sourceDir = mkdtempSync(join(tmpdir(), 'orca-claude-source-keychain-empty-'))
    vi.mocked(readActiveClaudeKeychainCredentialsStrict).mockImplementation(async (configDir) =>
      configDir ? null : 'legacy-credentials'
    )
    const deps = makeDeps()
    const { ClaudeAccountService } = await import('./service')
    const service = new ClaudeAccountService(
      deps.store as never,
      deps.rateLimits as never,
      deps.runtimeAuth as never
    )
    ;(service as unknown as { runClaudeCommand: () => Promise<string> }).runClaudeCommand = vi.fn(
      async () => '{"email":"existing@example.com"}'
    )

    await expect(service.addAccountFromConfigDir(sourceDir)).rejects.toThrow(
      'no OAuth credentials were captured'
    )
    expect(deps.getSettings().claudeManagedAccounts).toHaveLength(0)
  })

  it('captures a legacy Keychain credential that changed after login began', async () => {
    setPlatform('darwin')
    sourceDir = mkdtempSync(join(tmpdir(), 'orca-claude-source-keychain-legacy-'))
    const previousCredentials = '{"claudeAiOauth":{"accessToken":"previous"}}'
    const newCredentials = '{"claudeAiOauth":{"accessToken":"new","email":"new@example.com"}}'
    vi.mocked(readActiveClaudeKeychainCredentialsStrict).mockImplementation(async (configDir) =>
      configDir ? null : newCredentials
    )
    const deps = makeDeps()
    const { ClaudeAccountService } = await import('./service')
    const service = new ClaudeAccountService(
      deps.store as never,
      deps.rateLimits as never,
      deps.runtimeAuth as never
    )
    ;(service as unknown as { runClaudeCommand: () => Promise<string> }).runClaudeCommand = vi.fn(
      async () => '{"email":"new@example.com"}'
    )

    await service.addAccountFromConfigDir(sourceDir, {
      previousLegacyCredentialsSha256: createHash('sha256')
        .update(previousCredentials)
        .digest('hex')
    })

    expect(writeManagedClaudeKeychainCredentials).toHaveBeenCalledWith(
      expect.any(String),
      newCredentials
    )
    expect(deps.getSettings().claudeManagedAccounts[0]?.email).toBe('new@example.com')
  })

  it('still registers when the daemon cannot spawn `claude auth status`', async () => {
    // Why: `allowFailure` covers a non-zero exit but not a spawn error, so a daemon
    // started with a minimal PATH would hard-fail an add the user already signed in for.
    sourceDir = mkdtempSync(join(tmpdir(), 'orca-claude-source-nostatus-'))
    writeFileSync(
      join(sourceDir, '.credentials.json'),
      '{"claudeAiOauth":{"accessToken":"tok"}}\n',
      'utf-8'
    )
    writeFileSync(
      join(sourceDir, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'new@example.com' } }),
      'utf-8'
    )

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const deps = makeDeps()
    const { ClaudeAccountService } = await import('./service')
    const service = new ClaudeAccountService(
      deps.store as never,
      deps.rateLimits as never,
      deps.runtimeAuth as never
    )
    ;(service as unknown as { runClaudeCommand: () => Promise<string> }).runClaudeCommand = vi.fn(
      async () => {
        throw Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' })
      }
    )

    const result = await service.addAccountFromConfigDir(sourceDir)

    expect(result.accounts[0]?.email).toBe('new@example.com')
    expect(deps.getSettings().claudeManagedAccounts).toHaveLength(1)
    warn.mockRestore()
  })

  it('rejects and rolls back when the config dir has no credentials', async () => {
    sourceDir = mkdtempSync(join(tmpdir(), 'orca-claude-source-empty-'))
    const deps = makeDeps()
    const { ClaudeAccountService } = await import('./service')
    const service = new ClaudeAccountService(
      deps.store as never,
      deps.rateLimits as never,
      deps.runtimeAuth as never
    )

    await expect(service.addAccountFromConfigDir(sourceDir)).rejects.toThrow(
      /No Claude credentials found/
    )
    expect(deps.getSettings().claudeManagedAccounts).toHaveLength(0)
    expect(deps.runtimeAuth.forceMaterializeCurrentSelectionForRollback).toHaveBeenCalled()
  })
})
