import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  resetClaudeKeychainMocks,
  restorePlatform,
  setPlatform
} from './claude-account-service-test-harness'

const CLAUDE_SERVICE_TEST_ROOT = join(tmpdir(), 'orca-claude-service-reauth-pinned-test')

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

import * as registry from './claude-pinned-pty-registry'

type LoginCapture = {
  credentialsJson: string
  oauthAccount: unknown
  identity: { email: string; organizationUuid: null; organizationName: null }
}

async function setUp(syncForCurrentSelection: () => Promise<void> = async () => {}) {
  rmSync(CLAUDE_SERVICE_TEST_ROOT, { recursive: true, force: true })
  const managedAuthPath = join(CLAUDE_SERVICE_TEST_ROOT, 'claude-accounts', 'account-1', 'auth')
  mkdirSync(managedAuthPath, { recursive: true })
  writeFileSync(join(managedAuthPath, '.orca-managed-claude-auth'), 'account-1\n', 'utf-8')
  writeFileSync(join(managedAuthPath, '.credentials.json'), '{"old":true}\n', 'utf-8')
  writeFileSync(join(managedAuthPath, 'oauth-account.json'), '{"oldOauth":true}\n', 'utf-8')
  let settings = {
    claudeManagedAccounts: [
      {
        id: 'account-1',
        email: 'pinned@example.com',
        managedAuthPath,
        authMethod: 'subscription-oauth',
        organizationUuid: null,
        organizationName: null,
        createdAt: 1,
        updatedAt: 1,
        lastAuthenticatedAt: 1
      }
    ],
    activeClaudeManagedAccountId: null
  }
  const store = {
    getSettings: vi.fn(() => settings),
    updateSettings: vi.fn((updates: Partial<typeof settings>) => {
      settings = { ...settings, ...updates }
      return settings
    })
  }
  const runtimeAuth = {
    clearLastWrittenCredentialsJson: vi.fn(),
    forceMaterializeCurrentSelectionForRollback: vi.fn(async () => {}),
    syncForCurrentSelection: vi.fn(syncForCurrentSelection)
  }
  const rateLimits = {
    evictInactiveClaudeCache: vi.fn(),
    refreshForClaudeAccountChange: vi.fn(async () => {})
  }
  const { ClaudeAccountService } = await import('./service')
  const service = new ClaudeAccountService(
    store as never,
    rateLimits as never,
    runtimeAuth as never
  )
  const login = vi.fn(async (): Promise<LoginCapture> => ({
    credentialsJson: '{"new":true}\n',
    oauthAccount: { newOauth: true },
    identity: { email: 'pinned@example.com', organizationUuid: null, organizationName: null }
  }))
  ;(service as unknown as { runClaudeLoginAndCapture: typeof login }).runClaudeLoginAndCapture =
    login
  const readCredentials = (): string =>
    readFileSync(join(managedAuthPath, '.credentials.json'), 'utf-8')
  return { service, login, readCredentials }
}

describe('ClaudeAccountService re-auth of a pinned account', () => {
  beforeEach(() => {
    setPlatform('linux')
    resetClaudeKeychainMocks()
  })

  afterEach(() => {
    registry._internals.reset()
    restorePlatform()
    rmSync(CLAUDE_SERVICE_TEST_ROOT, { recursive: true, force: true })
  })

  it('refuses before opening a login while an --account terminal holds the account', async () => {
    const { service, login, readCredentials } = await setUp()
    registry.markPinnedClaudePtySpawned('pinned-pty', 'account-1')

    await expect(service.reauthenticateAccount('account-1')).rejects.toThrow(
      'in use by 1 terminal launched with --account. Close it before you re-authenticate'
    )

    expect(login).not.toHaveBeenCalled()
    expect(readCredentials()).toBe('{"old":true}\n')
  })

  it('discards the login when a pinned launch reserved the account meanwhile', async () => {
    const { service, login, readCredentials } = await setUp()
    login.mockImplementationOnce(async () => {
      expect(registry.reserveClaudePinnedAccount('account-1')).toBeNull()
      return {
        credentialsJson: '{"new":true}\n',
        oauthAccount: { newOauth: true },
        identity: { email: 'pinned@example.com', organizationUuid: null, organizationName: null }
      }
    })

    await expect(service.reauthenticateAccount('account-1')).rejects.toThrow(
      /in use by 1 terminal launched with --account/
    )

    expect(readCredentials()).toBe('{"old":true}\n')
  })

  it('holds the account against pinned launches from the write until it finishes', async () => {
    const reservationsDuringSync: (string | null)[] = []
    const { service, readCredentials } = await setUp(async () => {
      reservationsDuringSync.push(registry.reserveClaudePinnedAccount('account-1'))
    })

    await service.reauthenticateAccount('account-1')

    expect(readCredentials()).toBe('{"new":true}\n')
    expect(reservationsDuringSync).toEqual(['host-mutation'])
    expect(registry.reserveClaudePinnedAccount('account-1')).toBeNull()
  })
})
