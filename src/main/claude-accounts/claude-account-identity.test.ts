import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { ClaudeManagedAccount } from '../../shared/managed-account-types'
import { ClaudeAccountSelection } from './claude-account-selection'
import { createNativeClaudeProfileRouting } from './claude-profile-native-owner'
import { describeClaudeProfile, prepareClaudeProfileDirectory } from './claude-profile-paths'
import { installClaudeProfileRoutingAuthority } from './claude-profile-routing-authority'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'claude-identity-'))
  roots.push(root)
  const home = join(root, 'personal')
  const dataRoot = join(root, 'data')
  mkdirSync(home)
  mkdirSync(dataRoot)
  const account = (id: string, email: string, lastAuthenticatedAt: number) => ({
    id,
    email,
    authMethod: 'subscription-oauth' as const,
    managedAuthPath: '/unused-legacy',
    createdAt: 0,
    updatedAt: 0,
    lastAuthenticatedAt
  })
  const settings: {
    claudeManagedAccounts: ClaudeManagedAccount[]
    activeClaudeManagedAccountId: string | null
    activeClaudeManagedAccountIdsByRuntime: { host: string | null; wsl: Record<string, string> }
    agentStatusHooksEnabled: boolean
    disabledTuiAgents: []
  } = {
    claudeManagedAccounts: [account('a', 'a@example.test', 1), account('b', 'bb@example.test', 2)],
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
  const signIn = (id: string, email: string) => {
    const profile = describeClaudeProfile(dataRoot, id, {
      runtime: 'host',
      executionHostId: 'local'
    })
    prepareClaudeProfileDirectory(dataRoot, profile, home)
    writeFileSync(
      join(profile.home, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: email, organizationUuid: null } })
    )
  }
  const selection = new ClaudeAccountSelection(
    {
      getSettings: () => settings,
      updateSettings: (patch) => Object.assign(settings, patch)
    },
    {
      evictInactiveClaudeCache: vi.fn(),
      refreshForClaudeAccountChange: vi.fn().mockResolvedValue(undefined)
    },
    {
      syncForCurrentSelection: async () => {},
      forceMaterializeCurrentSelectionForRollback: async () => {}
    }
  )
  const rows = () =>
    selection
      .list()
      .accounts.map((entry) => [
        entry.id,
        entry.email,
        entry.profileEmail,
        entry.profileIdentityIssue
      ])
      .sort(([left], [right]) => String(left).localeCompare(String(right)))
  const signInDefault = (email: string) =>
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: email } })
    )
  return { settings, signIn, signInDefault, selection, rows, account }
}

it('labels each row with the login its profile holds and flags a row holding another login', async () => {
  const f = fixture()
  f.signIn('a', 'a@example.test')
  f.signIn('b', 'bb@example.test')
  expect(f.rows()).toEqual([
    ['a', 'a@example.test', 'a@example.test', undefined],
    ['b', 'bb@example.test', 'bb@example.test', undefined]
  ])
  // A `/login` inside b's profile as a's login: a keeps its row, b says what it holds.
  f.signIn('b', 'a@example.test')
  expect(f.rows()).toEqual([
    ['a', 'a@example.test', 'a@example.test', undefined],
    ['b', 'bb@example.test', 'a@example.test', 'duplicate']
  ])
  await expect(f.selection.select('b')).rejects.toThrow(
    'This account was added as bb@example.test but is now signed in as a@example.test, which is already added as another account. Sign in again as bb@example.test, or remove this account.'
  )
  f.signIn('b', 'someone-else@example.test')
  expect(f.rows()[1]).toEqual(['b', 'bb@example.test', 'someone-else@example.test', 'mismatch'])
  await expect(f.selection.select('b')).rejects.toThrow(
    'This account was added as bb@example.test but is now signed in as someone-else@example.test.'
  )
  await expect(f.selection.select('a')).resolves.toHaveProperty('accounts')
})

it('turns an unfinished sign-in whose login completed into a normal account without a new login', () => {
  const f = fixture()
  f.signIn('a', 'a@example.test')
  f.settings.claudeManagedAccounts.push(f.account('draft', '', 0))
  f.signIn('draft', 'cc@example.test')
  expect(f.rows().find(([id]) => id === 'draft')).toEqual([
    'draft',
    'cc@example.test',
    'cc@example.test',
    undefined
  ])
  expect(f.settings.claudeManagedAccounts.find((entry) => entry.id === 'draft')).toMatchObject({
    email: 'cc@example.test',
    authMethod: 'subscription-oauth'
  })
})

it('keeps an unfinished sign-in holding an already added login flagged instead of adopting it', () => {
  const f = fixture()
  f.signIn('a', 'a@example.test')
  f.settings.claudeManagedAccounts.push(f.account('draft', '', 0))
  f.signIn('draft', 'a@example.test')
  expect(f.rows().find(([id]) => id === 'draft')).toEqual([
    'draft',
    '',
    'a@example.test',
    'duplicate'
  ])
})

it("names System Default's own login and flags one an earlier Orca left there", () => {
  const f = fixture()
  f.signIn('a', 'a@example.test')
  expect(f.selection.list().systemDefault).toEqual({ email: null, matchesSavedAccount: false })
  f.signInDefault('a@example.test')
  expect(f.selection.list().systemDefault).toEqual({
    email: 'a@example.test',
    matchesSavedAccount: true
  })
  f.signInDefault('mine@example.test')
  expect(f.selection.list().systemDefault).toEqual({
    email: 'mine@example.test',
    matchesSavedAccount: false
  })
})

it('surfaces the last setup warning on the account row and clears it after a clean setup', async () => {
  const { recordClaudeProfileSetupReport } = await import('./claude-profile-setup-issues')
  const f = fixture()
  f.signIn('a', 'a@example.test')
  recordClaudeProfileSetupReport('a', {
    warnings: [{ surface: 'hooks', code: 'failed', detail: 'hook install failed' }]
  })
  expect(f.selection.list().accounts.find((entry) => entry.id === 'a')?.profileSetupIssue).toBe(
    'hooks'
  )
  recordClaudeProfileSetupReport('a', { warnings: [] })
  expect(
    f.selection.list().accounts.find((entry) => entry.id === 'a')?.profileSetupIssue
  ).toBeUndefined()
})

it('does not read the personal Claude state file when no account is saved', () => {
  const f = fixture()
  f.signInDefault('me@example.test')
  f.settings.claudeManagedAccounts = []
  expect(f.selection.list().systemDefault).toBeUndefined()
})

it('does not read the personal Claude state file when only an unfinished sign-in exists', () => {
  const f = fixture()
  f.signInDefault('me@example.test')
  f.settings.claudeManagedAccounts = [f.account('draft', '', 0)]
  expect(f.selection.list().systemDefault).toBeUndefined()
})
