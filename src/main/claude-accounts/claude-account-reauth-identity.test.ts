import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type {
  ClaudeManagedAccount,
  ClaudeManagedAccountRuntimeSelection
} from '../../shared/managed-account-types'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { ClaudeAccountSelection } from './claude-account-selection'
import { ClaudeAccountRegistration } from './claude-account-registration'
import { createNativeClaudeProfileRouting } from './claude-profile-native-owner'
import { describeClaudeProfile, prepareClaudeProfileDirectory } from './claude-profile-paths'
import { installClaudeProfileRoutingAuthority } from './claude-profile-routing-authority'

vi.mock('../macos-keychain/generic-password', () => ({
  readKeychainPassword: () => {
    throw new Error('no keychain')
  }
}))

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

function fixture(accounts: ClaudeManagedAccount[]) {
  const root = mkdtempSync(join(tmpdir(), 'r2a-'))
  roots.push(root)
  const home = join(root, 'personal')
  const dataRoot = join(root, 'data')
  mkdirSync(home)
  mkdirSync(dataRoot)
  const settings: Pick<
    GlobalSettings,
    | 'claudeManagedAccounts'
    | 'activeClaudeManagedAccountId'
    | 'agentStatusHooksEnabled'
    | 'disabledTuiAgents'
  > & { activeClaudeManagedAccountIdsByRuntime: ClaudeManagedAccountRuntimeSelection } = {
    claudeManagedAccounts: accounts,
    activeClaudeManagedAccountId: null,
    activeClaudeManagedAccountIdsByRuntime: { host: null, wsl: {} },
    agentStatusHooksEnabled: false,
    disabledTuiAgents: []
  }
  const routing = createNativeClaudeProfileRouting({
    store: { getSettings: () => settings },
    dataRoot,
    userHome: home,
    inheritedConfigDir: () => null,
    claudeVersion: async () => null,
    worker: { prepare: async () => ({ outcome: 'prepared', surfaces: {}, warnings: [] }) }
  })
  installClaudeProfileRoutingAuthority(routing)
  const notified: Partial<typeof settings>[] = []
  const store = {
    getSettings: () => settings,
    updateSettings: (patch: Partial<typeof settings>, options?: { notifyListeners?: boolean }) => {
      if (options?.notifyListeners) {
        notified.push(patch)
      }
      return Object.assign(settings, patch)
    }
  }
  const rateLimits = {
    evictInactiveClaudeCache: vi.fn(),
    refreshForClaudeAccountChange: vi.fn().mockResolvedValue(undefined)
  }
  const selection = new ClaudeAccountSelection(store, rateLimits, {
    syncForCurrentSelection: async () => {},
    forceMaterializeCurrentSelectionForRollback: async () => {}
  })
  // The browser's Claude login decides which account Claude writes into the profile.
  let browserLogin = 'x@example.test'
  const profileHome = (id: string) => {
    const profile = describeClaudeProfile(dataRoot, id, {
      runtime: 'host',
      executionHostId: 'local'
    })
    prepareClaudeProfileDirectory(dataRoot, profile, home)
    return profile.home
  }
  const registration = new ClaudeAccountRegistration({
    store,
    rateLimits,
    runtimeAuth: { syncForCurrentSelection: async () => {} },
    selection,
    setCancel: () => {},
    prepare: async (id: string) => ({
      config: { windowsPath: profileHome(id), linuxPath: null, wslDistro: null },
      provision: async () => {}
    }),
    login: async (config) => {
      writeFileSync(
        join(config.windowsPath, '.claude.json'),
        JSON.stringify({ oauthAccount: { emailAddress: browserLogin, organizationUuid: 'org-1' } })
      )
    }
  })
  const rows = () =>
    selection
      .list()
      .accounts.map((entry) => [
        entry.id,
        entry.email,
        entry.profileReadiness,
        entry.profileIdentityIssue ?? null
      ])
      .sort(([l], [r]) => String(l).localeCompare(String(r)))
  return {
    settings,
    notified,
    routing,
    selection,
    registration,
    rows,
    signInAs: (email: string) => (browserLogin = email),
    signInRow: (id: string, email: string) =>
      writeFileSync(
        join(profileHome(id), '.claude.json'),
        JSON.stringify({ oauthAccount: { emailAddress: email, organizationUuid: 'org-1' } })
      )
  }
}

const legacy = (id: string, email: string, lastAuthenticatedAt: number): ClaudeManagedAccount => ({
  id,
  email,
  organizationUuid: 'org-1',
  authMethod: 'subscription-oauth',
  managedAuthPath: '/old-layout',
  managedAuthRuntime: 'host',
  wslDistro: null,
  createdAt: lastAuthenticatedAt,
  updatedAt: lastAuthenticatedAt,
  lastAuthenticatedAt
})

it('keeps the original row when a re-sign-in lands on a login another row already owns', async () => {
  const f = fixture([legacy('a', 'a@example.test', 1), legacy('b', 'b@example.test', 2)])
  // The user clicks Sign in again on a@ while the browser is signed in to b@.
  f.signInAs('b@example.test')
  await expect(f.registration.reauthenticate('a')).rejects.toThrow(
    'This account was added as a@example.test but is now signed in as b@example.test, which is already added as another account. Sign in again as a@example.test, or remove this account.'
  )
  expect(f.rows()).toEqual([
    ['a', 'a@example.test', 'ready', 'duplicate'],
    ['b', 'b@example.test', 'sign-in-required', null]
  ])
  // Signing the real b@ row in as b@ succeeds and leaves it the clean b@ row.
  await expect(f.registration.reauthenticate('b')).resolves.toHaveProperty('accounts')
  expect(f.rows()).toEqual([
    ['a', 'a@example.test', 'ready', 'duplicate'],
    ['b', 'b@example.test', 'ready', null]
  ])
  await expect(f.selection.select('b')).resolves.toHaveProperty('accounts')
  // Signing a@ back in to its own login clears its flag.
  f.signInAs('a@example.test')
  await expect(f.registration.reauthenticate('a')).resolves.toHaveProperty('accounts')
  expect(f.rows()).toEqual([
    ['a', 'a@example.test', 'ready', null],
    ['b', 'b@example.test', 'ready', null]
  ])
})

it('lets a new sign-in take over a saved account that still needs its fresh sign-in', async () => {
  const f = fixture([legacy('a', 'a@example.test', 1)])
  f.settings.activeClaudeManagedAccountId = 'a'
  f.settings.activeClaudeManagedAccountIdsByRuntime.host = 'a'
  f.signInAs('a@example.test')
  await expect(f.registration.add()).resolves.toHaveProperty('accounts')
  const [row] = f.settings.claudeManagedAccounts
  expect(f.settings.claudeManagedAccounts).toHaveLength(1)
  expect(row).toMatchObject({ email: 'a@example.test', createdAt: 1 })
  expect(row.id).not.toBe('a')
  expect(f.settings.activeClaudeManagedAccountIdsByRuntime.host).toBe(row.id)
  expect(f.rows()).toEqual([[row.id, 'a@example.test', 'ready', null]])
})

it('refuses adding an account that is already saved and signed in, leaving no second row', async () => {
  const f = fixture([legacy('a', 'a@example.test', 1)])
  f.signInRow('a', 'a@example.test')
  f.signInAs('a@example.test')
  await expect(f.registration.add()).rejects.toThrow('This Claude account is already added.')
  expect(f.rows()).toEqual([['a', 'a@example.test', 'ready', null]])
})

it('adds a login whose saved account now holds another login, keeping that one flagged', async () => {
  const f = fixture([legacy('x', 'a@example.test', 1)])
  // A `/login` in x's terminal left x signed in as c@, so no account holds a@.
  f.signInRow('x', 'c@example.test')
  expect(f.rows()).toEqual([['x', 'a@example.test', 'ready', 'mismatch']])
  f.signInAs('a@example.test')
  await expect(f.registration.add()).resolves.toHaveProperty('accounts')
  const added = f.settings.claudeManagedAccounts.find((entry) => entry.id !== 'x')
  expect(f.rows()).toEqual(
    [
      ['x', 'a@example.test', 'ready', 'mismatch'],
      [added?.id, 'a@example.test', 'ready', null]
    ].sort(([l], [r]) => String(l).localeCompare(String(r)))
  )
})

it('refuses to launch a selected account that is now signed in to another saved account', async () => {
  const f = fixture([legacy('a', 'a@example.test', 1), legacy('b', 'b@example.test', 2)])
  f.signInRow('a', 'a@example.test')
  f.signInRow('b', 'b@example.test')
  f.settings.activeClaudeManagedAccountId = 'a'
  f.settings.activeClaudeManagedAccountIdsByRuntime.host = 'a'
  expect(f.routing.resolve({ runtime: 'host' }).profile?.accountId).toBe('a')
  // A `/login` in a@'s terminal as b@ leaves the selected row holding b@'s login.
  f.signInRow('a', 'b@example.test')
  expect(() => f.routing.resolve({ runtime: 'host' })).toThrow(
    'This account was added as a@example.test but is now signed in as b@example.test, which is already added as another account. Sign in again as a@example.test, or remove this account.'
  )
  await expect(f.routing.publish({ runtime: 'host' })).rejects.toThrow('or remove this account.')
  f.signInRow('a', 'a@example.test')
  expect(f.routing.resolve({ runtime: 'host' }).profile?.accountId).toBe('a')
})

it('tells every window when a selection or sign-in changes the Claude settings', async () => {
  const f = fixture([legacy('a', 'a@example.test', 1)])
  f.signInRow('a', 'a@example.test')
  await f.selection.select('a')
  expect(f.notified.at(-1)).toMatchObject({ activeClaudeManagedAccountId: 'a' })
  f.signInAs('a@example.test')
  await f.registration.reauthenticate('a')
  expect(f.notified.at(-1)).toHaveProperty('claudeManagedAccounts')
})
