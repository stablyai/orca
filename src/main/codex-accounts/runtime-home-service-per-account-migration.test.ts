import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CodexManagedAccount, GlobalSettings } from '../../shared/types'
import type * as NodeOs from 'node:os'
import { readHookTrustEntries } from '../codex/config-toml-trust'

const testState = { userData: '', home: '' }
const previousEnv: Record<string, string | undefined> = {}

vi.mock('electron', () => ({ app: { getPath: () => testState.userData } }))
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os')
  return { ...actual, homedir: () => testState.home }
})

beforeEach(() => {
  vi.resetModules()
  testState.userData = mkdtempSync(join(tmpdir(), 'orca-codex-e-migration-'))
  testState.home = mkdtempSync(join(tmpdir(), 'orca-codex-e-home-'))
  for (const key of [
    'ORCA_USER_DATA_PATH',
    'ORCA_CODEX_SYSTEM_DEFAULT_REAL_HOME',
    'ORCA_DISABLE_CODEX_TRUST_RPC',
    'CODEX_HOME',
    'ORCA_CODEX_HOME'
  ]) {
    previousEnv[key] = process.env[key]
    delete process.env[key]
  }
  process.env.ORCA_USER_DATA_PATH = testState.userData
  process.env.ORCA_DISABLE_CODEX_TRUST_RPC = '1'
  mkdirSync(systemHome(), { recursive: true })
  mkdirSync(sharedHome(), { recursive: true })
})

afterEach(() => {
  rmSync(testState.userData, { recursive: true, force: true })
  rmSync(testState.home, { recursive: true, force: true })
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
})

describe('CodexRuntimeHomeService per-account takeover composition', () => {
  it('upgrades a realistic two-account shared-home fixture without losing auth or sessions', async () => {
    const accountOneStale = createAuth('one@example.com', 'acct-1', 'one-stale', 1_000)
    const accountOneMigrated = createAuth('one@example.com', 'acct-1', 'one-migrated', 2_000)
    const accountTwoAuth = createAuth('two@example.com', 'acct-2', 'two-current', 3_000)
    const accountOne = createManagedAccount('account-1', 'acct-1', accountOneStale)
    const accountTwo = createManagedAccount(
      'account-2',
      'acct-2',
      accountTwoAuth,
      'two@example.com'
    )
    const sharedSession = join(sharedHome(), 'sessions', '2026', '07', 'rollout.jsonl')
    mkdirSync(join(systemHome(), 'skills', 'fixture-skill'), { recursive: true })
    mkdirSync(join(systemHome(), 'hooks'), { recursive: true })
    mkdirSync(join(sharedHome(), 'sessions', '2026', '07'), { recursive: true })
    writeFileSync(join(systemHome(), 'skills', 'fixture-skill', 'SKILL.md'), 'fixture skill\n')
    writeFileSync(join(systemHome(), 'hooks', 'user-hook.sh'), '#!/bin/sh\n')
    writeFileSync(
      join(systemHome(), 'config.toml'),
      'model = "fixture-model"\n\n[hooks.state."stale-fixture"]\nenabled = true\n'
    )
    writeFileSync(sharedSession, '{"session":"legacy-shared"}\n')
    writeFileSync(sharedAuthPath(), accountOneMigrated)
    const { settings, store } = createStore([accountOne, accountTwo], accountOne.id)
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const { CodexHookService } = await import('../codex/hook-service')
    const service = new CodexRuntimeHomeService(store as never)
    const hookService = new CodexHookService()

    expect(readFileSync(join(accountOne.managedHomePath, 'auth.json'), 'utf8')).toBe(
      accountOneMigrated
    )
    expect(readFileSync(join(accountTwo.managedHomePath, 'auth.json'), 'utf8')).toBe(accountTwoAuth)

    for (const account of [accountOne, accountTwo]) {
      selectManagedAccount(settings, account.id)
      service.syncForCurrentSelection()
      expect(service.prepareForCodexLaunch()).toBe(account.managedHomePath)
      expect(
        readFileSync(join(account.managedHomePath, 'skills', 'fixture-skill', 'SKILL.md'), 'utf8')
      ).toBe('fixture skill\n')
      expect(readFileSync(join(account.managedHomePath, 'hooks', 'user-hook.sh'), 'utf8')).toBe(
        '#!/bin/sh\n'
      )
      const config = readFileSync(join(account.managedHomePath, 'config.toml'), 'utf8')
      expect(config).toContain('model = "fixture-model"')
      expect(config).not.toContain('[hooks.state')
      expect(hookService.install(account.managedHomePath).state).toBe('installed')
      expect(readFileSync(join(account.managedHomePath, 'hooks.json'), 'utf8')).toContain(
        process.platform === 'win32' ? 'codex-hook.cmd' : 'codex-hook.sh'
      )
      expect(
        readHookTrustEntries(join(account.managedHomePath, 'config.toml')).size
      ).toBeGreaterThan(0)
    }

    const discoveryHomes = service.getHostCodexHomePathsForSessionDiscovery()
    expect(discoveryHomes).toEqual(
      expect.arrayContaining([
        sharedHome(),
        systemHome(),
        accountOne.managedHomePath,
        accountTwo.managedHomePath
      ])
    )
    expect(new Set(discoveryHomes).size).toBe(discoveryHomes.length)
    expect(readFileSync(sharedSession, 'utf8')).toBe('{"session":"legacy-shared"}\n')

    writeFileSync(sharedAuthPath(), createAuth('two@example.com', 'acct-2', 'later-shared', 4_000))
    expect(service.prepareForCodexLaunch()).toBe(accountTwo.managedHomePath)
    expect(readFileSync(join(accountTwo.managedHomePath, 'auth.json'), 'utf8')).toBe(accountTwoAuth)
  })

  it('migrates the one proven C-era refresh, launches E home, then ignores shared auth', async () => {
    const stale = createAuth('one@example.com', 'acct-1', 'stale', 1_000)
    const migrated = createAuth('one@example.com', 'acct-1', 'migrated', 2_000)
    const laterShared = createAuth('one@example.com', 'acct-1', 'later-shared', 3_000)
    const account = createManagedAccount('account-1', 'acct-1', stale)
    writeFileSync(sharedAuthPath(), migrated, 'utf-8')
    writeFileSync(systemAuthPath(), 'system auth sentinel\n', 'utf-8')
    const { settings, store } = createStore([account], account.id)
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')

    const service = new CodexRuntimeHomeService(store as never)

    expect(readFileSync(join(account.managedHomePath, 'auth.json'), 'utf-8')).toBe(migrated)
    expect(service.prepareForCodexLaunch()).toBe(account.managedHomePath)
    writeFileSync(sharedAuthPath(), laterShared, 'utf-8')
    expect(service.prepareForRateLimitFetch()).toBe(account.managedHomePath)
    expect(service.prepareForCodexLaunch()).toBe(account.managedHomePath)
    expect(readFileSync(join(account.managedHomePath, 'auth.json'), 'utf-8')).toBe(migrated)
    expect(readFileSync(systemAuthPath(), 'utf-8')).toBe('system auth sentinel\n')
    expect(settings.activeCodexManagedAccountId).toBe(account.id)
  })

  it('keeps E in-place auth when selection becomes real-home without an explicit sync', async () => {
    const fresh = createAuth('one@example.com', 'acct-1', 'e-refresh', 3_000)
    const mismatch = createAuth('other@example.com', 'acct-other', 'stale-shared', 4_000)
    const account = createManagedAccount('account-1', 'acct-1', fresh)
    writeFileSync(sharedAuthPath(), mismatch, 'utf-8')
    writeFileSync(systemAuthPath(), 'system auth sentinel\n', 'utf-8')
    const { settings, store } = createStore([account], account.id)
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    settings.activeCodexManagedAccountId = null
    settings.activeCodexManagedAccountIdsByRuntime = { host: null, wsl: {} }

    expect(service.prepareForCodexLaunch()).toBeNull()
    expect(service.prepareForRateLimitFetch()).toBe(systemHome())
    expect(readFileSync(join(account.managedHomePath, 'auth.json'), 'utf-8')).toBe(fresh)
    expect(readFileSync(sharedAuthPath(), 'utf-8')).toBe(mismatch)
    expect(readFileSync(systemAuthPath(), 'utf-8')).toBe('system auth sentinel\n')
  })

  it('never continuously recovers a missing E auth from shared state after takeover', async () => {
    const stale = createAuth('one@example.com', 'acct-1', 'stale', 1_000)
    const takeover = createAuth('one@example.com', 'acct-1', 'takeover', 2_000)
    const laterShared = createAuth('one@example.com', 'acct-1', 'later-shared', 3_000)
    const account = createManagedAccount('account-1', 'acct-1', stale)
    writeFileSync(sharedAuthPath(), takeover, 'utf-8')
    writeFileSync(systemAuthPath(), 'system auth sentinel\n', 'utf-8')
    const { settings, store } = createStore([account], account.id)
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)
    const accountAuthPath = join(account.managedHomePath, 'auth.json')
    expect(readFileSync(accountAuthPath, 'utf-8')).toBe(takeover)

    rmSync(accountAuthPath)
    writeFileSync(sharedAuthPath(), laterShared, 'utf-8')

    expect(service.prepareForCodexLaunch()).toBeNull()
    expect(existsSync(accountAuthPath)).toBe(false)
    expect(settings.activeCodexManagedAccountId).toBeNull()
    expect(readFileSync(sharedAuthPath(), 'utf-8')).toBe(laterShared)
    expect(readFileSync(systemAuthPath(), 'utf-8')).toBe('system auth sentinel\n')
  })

  it('does not expose an untrusted persisted home through rollout discovery', async () => {
    const outsideHome = join(testState.userData, 'outside', 'account-1', 'home')
    mkdirSync(join(outsideHome, 'sessions'), { recursive: true })
    writeFileSync(join(outsideHome, '.orca-managed-home'), 'account-1\n', 'utf-8')
    writeFileSync(
      join(outsideHome, 'auth.json'),
      createAuth('one@example.com', 'acct-1', 'outside', 1_000),
      'utf-8'
    )
    const account = managedAccountRecord('account-1', 'acct-1', outsideHome)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { store } = createStore([account], account.id)
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    expect(service.getHostCodexHomePathsForSessionDiscovery()).not.toContain(outsideHome)
    expect(warn).toHaveBeenCalled()
  })
})

function createStore(accounts: CodexManagedAccount[], activeId: string | null) {
  const settings = {
    codexManagedAccounts: accounts,
    activeCodexManagedAccountId: activeId,
    activeCodexManagedAccountIdsByRuntime: { host: activeId, wsl: {} }
  } as GlobalSettings
  return {
    settings,
    store: {
      getSettings: () => settings,
      updateSettings: (updates: Partial<GlobalSettings>) => Object.assign(settings, updates)
    }
  }
}

function createManagedAccount(
  id: string,
  providerId: string,
  auth: string,
  email = 'one@example.com'
): CodexManagedAccount {
  const home = join(testState.userData, 'codex-accounts', id, 'home')
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, '.orca-managed-home'), `${id}\n`, 'utf-8')
  writeFileSync(join(home, 'auth.json'), auth, 'utf-8')
  return managedAccountRecord(id, providerId, home, email)
}

function managedAccountRecord(
  id: string,
  providerAccountId: string,
  managedHomePath: string,
  email = 'one@example.com'
): CodexManagedAccount {
  return {
    id,
    email,
    managedHomePath,
    providerAccountId,
    workspaceLabel: null,
    workspaceAccountId: providerAccountId,
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1
  }
}

function selectManagedAccount(settings: GlobalSettings, accountId: string): void {
  settings.activeCodexManagedAccountId = accountId
  settings.activeCodexManagedAccountIdsByRuntime = { host: accountId, wsl: {} }
}

function systemHome(): string {
  return join(testState.home, '.codex')
}

function systemAuthPath(): string {
  return join(systemHome(), 'auth.json')
}

function sharedHome(): string {
  return join(testState.userData, 'codex-runtime-home', 'home')
}

function sharedAuthPath(): string {
  return join(sharedHome(), 'auth.json')
}

function createAuth(email: string, accountId: string, token: string, expiresAt: number): string {
  const header = Buffer.from('{}').toString('base64url')
  const payload = Buffer.from(
    JSON.stringify({
      email,
      exp: expiresAt,
      'https://api.openai.com/auth': {
        chatgpt_account_id: accountId,
        workspace_account_id: accountId
      }
    })
  ).toString('base64url')
  return `${JSON.stringify({
    tokens: {
      id_token: `${header}.${payload}.`,
      account_id: accountId,
      refresh_token: token,
      expires_at: expiresAt
    }
  })}\n`
}
