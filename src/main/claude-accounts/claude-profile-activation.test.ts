import type { GlobalSettings } from '../../shared/global-settings-types'
import { syncBuiltinESMExports } from 'node:module'
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import { afterEach, expect, it, vi } from 'vitest'
import fs, { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ClaudeManagedAccount } from '../../shared/managed-account-types'
import { ClaudeAccountRegistration } from './claude-account-registration'
import { readClaudeProfileState } from './claude-profile-readiness'
import { describeClaudeProfile, prepareClaudeProfileDirectory } from './claude-profile-paths'
import { claudeProfileRoutingEnabled } from '../../shared/claude-profile-routing'
import { loginToClaudeProfile } from './claude-profile-login'
import { provisionClaudeAccountProfile } from './claude-profile-setup'

vi.mock('../macos-keychain/generic-password', () => ({
  readKeychainPassword: () => {
    throw new Error('Lifecycle must not read the Keychain')
  }
}))
const roots: string[] = []
afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
  vi.restoreAllMocks()
  vi.useRealTimers()
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'claude-activation-'))
  roots.push(root)
  const accounts: ClaudeManagedAccount[] = []
  const settings: Pick<
    GlobalSettings,
    | 'claudeManagedAccounts'
    | 'activeClaudeManagedAccountId'
    | 'activeClaudeManagedAccountIdsByRuntime'
    | 'agentStatusHooksEnabled'
    | 'disabledTuiAgents'
  > = {
    claudeManagedAccounts: accounts,
    activeClaudeManagedAccountId: null,
    activeClaudeManagedAccountIdsByRuntime: { host: null, wsl: {} },
    agentStatusHooksEnabled: false,
    disabledTuiAgents: []
  }
  const identity: {
    email: string
    organizationUuid: string | null
    organizationName: string | null
  } = { email: 'fake@example.test', organizationUuid: null, organizationName: null }
  const login = vi.fn(async () => {})
  const observeIdentity = vi.fn(async (): Promise<typeof identity | null> => ({ ...identity }))
  const publish = vi.fn(async () => {})
  const rateLimits = {
    evictInactiveClaudeCache: vi.fn(),
    refreshForClaudeAccountChange: vi.fn().mockResolvedValue(undefined)
  }
  const provision = vi.fn(async () => {})
  const prepare = vi.fn(async (id: string) => ({
    config: {
      windowsPath: join(root, 'claude-profiles', id, 'home'),
      linuxPath: null,
      wslDistro: null
    },
    provision
  }))
  const registration = new ClaudeAccountRegistration({
    store: {
      getSettings: () => settings,
      updateSettings: (patch) => Object.assign(settings, patch)
    },
    selection: {
      requireAccount: (id) => {
        const account = settings.claudeManagedAccounts.find((entry) => entry.id === id)
        if (!account) {
          throw new Error('missing')
        }
        return account
      },
      list: () => ({ accounts: settings.claudeManagedAccounts, activeAccountId: null })
    },
    runtimeAuth: { syncForCurrentSelection: publish },
    rateLimits,
    setCancel: vi.fn(),
    prepare,
    login,
    observeIdentity
  })
  return {
    root,
    settings,
    identity,
    login,
    publish,
    prepare,
    observeIdentity,
    rateLimits,
    registration
  }
}
it('enables profile routing', () => expect(claudeProfileRoutingEnabled()).toBe(true))
it('retains a recoverable draft when login is interrupted, then retries the same final home', async () => {
  const f = fixture()
  f.login.mockRejectedValueOnce(new Error('cancelled'))
  await expect(f.registration.add()).rejects.toThrow('cancelled')
  const draft = f.settings.claudeManagedAccounts[0]
  expect(draft.lastAuthenticatedAt).toBe(0)
  expect(draft.managedAuthPath).toBe(join(f.root, 'claude-profiles', draft.id, 'home'))
  await f.registration.reauthenticate(draft.id)
  expect(f.settings.claudeManagedAccounts).toHaveLength(1)
  expect(f.settings.claudeManagedAccounts[0].email).toBe('fake@example.test')
  expect(f.prepare.mock.calls.every(([id]) => id === draft.id)).toBe(true)
})
it('refreshes active usage after a sign-in finishes', async () => {
  const f = fixture()
  await f.registration.add()
  expect(f.rateLimits.refreshForClaudeAccountChange).toHaveBeenCalledWith(undefined, {
    runtime: 'host'
  })
})
it('leaves no draft row when profile preparation fails before any login', async () => {
  const f = fixture()
  f.prepare.mockRejectedValue(new Error('Claude profile could not be prepared.'))
  await expect(f.registration.add({ runtime: 'wsl', wslDistro: 'Ubuntu' })).rejects.toThrow(
    'could not be prepared'
  )
  expect(f.settings.claudeManagedAccounts).toEqual([])
  expect(f.login).not.toHaveBeenCalled()
})
it('keeps an existing account when its sign-in preparation fails', async () => {
  const f = fixture()
  await f.registration.add()
  f.prepare.mockRejectedValueOnce(new Error('Claude profile could not be prepared.'))
  await expect(
    f.registration.reauthenticate(f.settings.claudeManagedAccounts[0].id)
  ).rejects.toThrow('could not be prepared')
  expect(f.settings.claudeManagedAccounts).toHaveLength(1)
})
it('publishes the first distro after registering its draft, before login', async () => {
  const f = fixture()
  f.publish.mockImplementation(async () => {
    expect(f.settings.claudeManagedAccounts).toHaveLength(1)
  })
  await f.registration.add({ runtime: 'wsl', wslDistro: 'Ubuntu' })
  expect(f.publish).toHaveBeenCalledWith({ runtime: 'wsl', wslDistro: 'Ubuntu' }, 'boot')
  expect(f.publish.mock.invocationCallOrder[0]).toBeLessThan(f.login.mock.invocationCallOrder[0])
})
it('derives upgrade, draft, ready and unavailable from profile files without reading legacy credentials', () => {
  const f = fixture()
  const userHome = join(f.root, 'user')
  mkdirSync(userHome)
  const legacy = join(userHome, 'legacy.credentials.json')
  writeFileSync(legacy, 'SENTINEL-NOT-IMPORTED')
  const profile = describeClaudeProfile(f.root, 'old', {
    runtime: 'host',
    executionHostId: 'local'
  })
  expect(readClaudeProfileState(f.root, profile).readiness).toBe('sign-in-required')
  prepareClaudeProfileDirectory(f.root, profile, userHome)
  expect(readClaudeProfileState(f.root, profile).readiness).toBe('sign-in-required')
  writeFileSync(
    join(profile.home, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: 'fake' } })
  )
  expect(readClaudeProfileState(f.root, profile).readiness).toBe('ready')
  writeFileSync(join(profile.home, '.claude.json'), '{')
  expect(readClaudeProfileState(f.root, profile).readiness).toBe('unavailable')
  expect(readFileSync(legacy, 'utf8')).toBe('SENTINEL-NOT-IMPORTED')
})
it("parses a profile's Claude state file once until it changes", () => {
  const f = fixture()
  const userHome = join(f.root, 'user')
  mkdirSync(userHome)
  const profile = describeClaudeProfile(f.root, 'big', {
    runtime: 'host',
    executionHostId: 'local'
  })
  prepareClaudeProfileDirectory(f.root, profile, userHome)
  const state = join(profile.home, '.claude.json')
  writeFileSync(state, JSON.stringify({ oauthAccount: { emailAddress: 'fake' } }))
  const parse = vi.spyOn(JSON, 'parse')
  const stateParses = () =>
    parse.mock.calls.filter(([text]) => String(text).includes('oauthAccount')).length
  expect(readClaudeProfileState(f.root, profile).readiness).toBe('ready')
  expect(readClaudeProfileState(f.root, profile).readiness).toBe('ready')
  expect(stateParses()).toBe(1)
  writeFileSync(state, JSON.stringify({ oauthAccount: null, other: true }))
  expect(readClaudeProfileState(f.root, profile).readiness).toBe('sign-in-required')
  rmSync(state)
  expect(readClaudeProfileState(f.root, profile).readiness).toBe('sign-in-required')
  writeFileSync(state, JSON.stringify({ oauthAccount: { emailAddress: 'fake' } }))
  expect(readClaudeProfileState(f.root, profile).readiness).toBe('ready')
})
it('runs Claude login directly in the supplied final home, with no cleanup on failure', async () => {
  const f = fixture()
  const config = { windowsPath: join(f.root, 'final'), linuxPath: null, wslDistro: null }
  const cancel = vi.fn()
  // Why: once the login returns, a superseding action must no longer be able to abort it.
  const run = vi.fn(async () => {
    expect(cancel).toHaveBeenLastCalledWith(expect.any(Function))
    return ''
  })
  await loginToClaudeProfile(config, cancel, run)
  expect(run.mock.calls).toHaveLength(1)
  expect(cancel).toHaveBeenLastCalledWith(null)
  expect(run).toHaveBeenNthCalledWith(
    1,
    ['auth', 'login', '--claudeai'],
    config,
    180000,
    expect.anything()
  )
  run.mockRejectedValueOnce(new Error('denied'))
  await expect(loginToClaudeProfile(config, cancel, run)).rejects.toThrow('denied')
  expect(cancel).toHaveBeenLastCalledWith(null)
})

it('dynamic mutation control trips on credential writes through the atomic helper', async () => {
  const f = fixture()
  const original = fs.writeFileSync
  const guard = vi.spyOn(fs, 'writeFileSync').mockImplementation((file, data, options) => {
    if (String(file).includes('.credentials.json')) {
      throw new Error('Credential writer tripwire')
    }
    return original(file, data, options)
  })
  syncBuiltinESMExports()
  try {
    expect(() => writeFileAtomically(join(f.root, '.credentials.json'), 'fake-token')).toThrow(
      'Credential writer tripwire'
    )
    guard.mockClear()
    await f.registration.add()
    const id = f.settings.claudeManagedAccounts[0].id
    await f.registration.reauthenticate(id)
    expect(guard).not.toHaveBeenCalled()
    const userHome = join(f.root, 'fake-home')
    mkdirSync(userHome)
    const profile = describeClaudeProfile(f.root, id, { executionHostId: 'local', runtime: 'host' })
    const report = await provisionClaudeAccountProfile({
      dataRoot: f.root,
      profile,
      userHome,
      installHooks: null
    })
    expect(report.outcome).toBe('prepared')
    expect(guard.mock.calls.some(([file]) => String(file).includes('.credentials.json'))).toBe(
      false
    )
  } finally {
    guard.mockRestore()
    syncBuiltinESMExports()
  }
})

it('retains profile files when unregistering, and keeps settings selection when only usage fails', async () => {
  const { ClaudeAccountSelection } = await import('./claude-account-selection')
  const f = fixture()
  await f.registration.add()
  const account = f.settings.claudeManagedAccounts[0]
  mkdirSync(account.managedAuthPath, { recursive: true })
  const credentials = join(account.managedAuthPath, '.credentials.json')
  writeFileSync(credentials, 'owned-by-fake-Claude')
  let activeClaudeManagedAccountId: string | null = account.id
  let activeClaudeManagedAccountIdsByRuntime: {
    host: string | null
    wsl: Record<string, string | null>
  } = { host: account.id, wsl: {} }
  const usage = {
    evictInactiveClaudeCache: vi.fn(),
    refreshForClaudeAccountChange: vi.fn().mockRejectedValue(new Error('usage unavailable'))
  }
  const selection = new ClaudeAccountSelection(
    {
      getSettings: () => ({
        ...f.settings,
        activeClaudeManagedAccountId,
        activeClaudeManagedAccountIdsByRuntime
      }),
      updateSettings: (patch) => {
        if (patch.claudeManagedAccounts) {
          f.settings.claudeManagedAccounts = patch.claudeManagedAccounts
        }
        if (patch.activeClaudeManagedAccountId !== undefined) {
          activeClaudeManagedAccountId = patch.activeClaudeManagedAccountId
        }
        if (patch.activeClaudeManagedAccountIdsByRuntime) {
          activeClaudeManagedAccountIdsByRuntime = patch.activeClaudeManagedAccountIdsByRuntime
        }
      }
    },
    usage,
    {
      syncForCurrentSelection: async () => {},
      forceMaterializeCurrentSelectionForRollback: async () => {}
    }
  )
  await selection.select(null)
  expect(activeClaudeManagedAccountId).toBeNull()
  await selection.select(account.id)
  usage.refreshForClaudeAccountChange.mockClear()
  await selection.remove(account.id)
  expect(usage.refreshForClaudeAccountChange).toHaveBeenCalledWith(account.id, { runtime: 'host' })
  expect(f.settings.claudeManagedAccounts).toEqual([])
  expect(readFileSync(credentials, 'utf8')).toBe('owned-by-fake-Claude')
})

it('does not let publication bookkeeping block signing in to a recoverable draft', async () => {
  const f = fixture()
  f.publish.mockRejectedValue(new Error('previous selected account needs sign-in'))
  await expect(f.registration.add()).resolves.toHaveProperty('accounts')
  expect(f.login).toHaveBeenCalledTimes(1)
  expect(f.settings.claudeManagedAccounts[0].email).toBe('fake@example.test')
})
it('refuses plainly when the profile holds no login after sign-in', async () => {
  const f = fixture()
  f.observeIdentity.mockResolvedValue(null)
  await expect(f.registration.add()).rejects.toThrow(
    'Claude sign-in finished, but Orca could not read which account it used. Try signing in again.'
  )
})
