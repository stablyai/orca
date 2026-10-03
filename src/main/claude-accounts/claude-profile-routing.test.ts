import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  symlinkSync,
  existsSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createNativeClaudeProfileRouting,
  inheritedClaudeConfigDir
} from './claude-profile-native-owner'
import type * as FsUtils from '../codex-accounts/fs-utils'
const writeFailure = vi.hoisted((): { error: Error | null } => ({ error: null }))
vi.mock('../codex-accounts/fs-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof FsUtils>()
  return {
    ...actual,
    writeFileAtomically: (...args: Parameters<typeof actual.writeFileAtomically>) => {
      if (writeFailure.error) {
        throw writeFailure.error
      }
      return actual.writeFileAtomically(...args)
    }
  }
})
import { resolveSkillProviderRoots } from '../runtime/runtime-skill-install-authority'
import { describeClaudeProfile, prepareClaudeProfileDirectory } from './claude-profile-paths'
import { publishClaudeProfilePointer, readClaudeProfilePointer } from './claude-profile-pointer'
import { requireClaudeProfileRoutingCapability } from '../../shared/claude-profile-routing'
import type { ClaudeManagedAccount } from '../../shared/managed-account-types'
import type { ClaudeProfileSetupReport } from './claude-profile-setup'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'profile-routing-'))
  roots.push(root)
  const home = join(root, 'personal')
  const dataRoot = join(root, 'data')
  mkdirSync(home)
  mkdirSync(dataRoot)
  const accounts: ClaudeManagedAccount[] = ['a', 'b'].map((id) => ({
    id,
    email: `${id}@example.test`,
    authMethod: 'subscription-oauth',
    managedAuthPath: '/unused-legacy',
    createdAt: 0,
    updatedAt: 0,
    lastAuthenticatedAt: 0
  }))
  const settings: {
    claudeManagedAccounts: ClaudeManagedAccount[]
    activeClaudeManagedAccountId: string | null
  } = { claudeManagedAccounts: accounts, activeClaudeManagedAccountId: 'a' }
  const worker = {
    prepare: vi.fn(async (): Promise<ClaudeProfileSetupReport> => ({
      outcome: 'prepared',
      warnings: [],
      surfaces: {}
    }))
  }
  const inherited: { dir?: string } = {}
  const routing = createNativeClaudeProfileRouting({
    store: {
      getSettings: () => ({ ...settings, agentStatusHooksEnabled: true, disabledTuiAgents: [] })
    },
    dataRoot,
    userHome: home,
    inheritedConfigDir: () => inherited.dir ?? null,
    worker,
    claudeVersion: async () => '2.1.261'
  })
  const profiles = ['a', 'b'].map((id) =>
    describeClaudeProfile(dataRoot, id, { runtime: 'host', executionHostId: 'local' })
  )
  profiles.forEach((profile) => {
    prepareClaudeProfileDirectory(dataRoot, profile, home)
    writeFileSync(
      join(profile.home, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: `${profile.accountId}@example.test` } })
    )
  })
  return { root, home, dataRoot, settings, worker, routing, profiles, inherited }
}
describe('native Claude profile authority', () => {
  it('re-derives the pointer at startup and selection, passes the version to the worker, and preserves an immutable launch', async () => {
    const f = fixture()
    const launchA = await f.routing.prepare()
    expect(readClaudeProfilePointer(f.routing.pointerPath())).toBe(f.profiles[0].home)
    f.settings.activeClaudeManagedAccountId = 'b'
    await f.routing.startup()
    expect(readClaudeProfilePointer(f.routing.pointerPath())).toBe(f.profiles[1].home)
    expect(launchA.envPatch.CLAUDE_CONFIG_DIR).toBe(f.profiles[0].home)
    expect(f.worker.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ claudeVersion: '2.1.261', hooksEnabled: true })
    )
    f.settings.activeClaudeManagedAccountId = null
    const system = await f.routing.prepare()
    expect(readFileSync(f.routing.pointerPath(), 'utf8')).toBe('')
    expect(system.stripAuthEnv).toBe(false)
    expect(system.envPatch).toEqual({ ORCA_CLAUDE_PROFILE_POINTER: f.routing.pointerPath() })
  })
  it('never manufactures missing profiles or silently uses default for a missing selection', async () => {
    const f = fixture()
    rmSync(f.profiles[0].home, { recursive: true })
    await expect(f.routing.prepare()).rejects.toThrow()
    expect(existsSync(f.profiles[0].home)).toBe(false)
    expect(f.worker.prepare).not.toHaveBeenCalled()
    f.settings.activeClaudeManagedAccountId = 'unknown'
    expect(() => f.routing.resolve()).toThrow('unavailable')
  })
  it('refuses escaped, wrong-owner and unavailable profiles', () => {
    const f = fixture()
    writeFileSync(
      join(f.dataRoot, 'claude-profiles/a/profile.json'),
      '{"version":1,"accountId":"b","runtime":"host"}'
    )
    expect(() => f.routing.resolve()).toThrow()
    f.settings.activeClaudeManagedAccountId = 'b'
    rmSync(f.profiles[1].home, { recursive: true })
    symlinkSync(f.home, f.profiles[1].home, 'dir')
    expect(() => f.routing.resolve()).toThrow()
  })
  it('does not publish a stale selection after asynchronous preparation', async () => {
    const f = fixture()
    f.worker.prepare.mockImplementationOnce(async () => {
      f.settings.activeClaudeManagedAccountId = 'b'
      return { outcome: 'prepared', surfaces: {}, warnings: [] }
    })
    await expect(f.routing.prepare()).rejects.toThrow('changed')
    expect(existsSync(f.routing.pointerPath())).toBe(false)
  })
  it('surfaces atomic publication failure and can recover from the authoritative selection', async () => {
    const f = fixture()
    mkdirSync(f.routing.pointerPath())
    await expect(f.routing.startup()).rejects.toThrow()
    rmSync(f.routing.pointerPath(), { recursive: true })
    await f.routing.startup()
    expect(readClaudeProfilePointer(f.routing.pointerPath())).toBe(f.profiles[0].home)
  })
  it('keeps a System Default pointer when rewriting it fails, and says why in plain words', async () => {
    const f = fixture()
    f.settings.activeClaudeManagedAccountId = null
    await f.routing.publish()
    writeFailure.error = Object.assign(new Error('ENOSPC: no space left on device, write'), {
      code: 'ENOSPC'
    })
    try {
      await expect(f.routing.publish()).rejects.toThrow('ENOSPC')
      expect(readClaudeProfilePointer(f.routing.pointerPath())).toBe(null)
      const issue = f.routing.describeAccounts({ accounts: [], activeAccountId: null })
      expect(issue.profileRoutingIssue).toBe(
        'Orca could not save the Claude account selection because the disk is full.'
      )
    } finally {
      writeFailure.error = null
    }
  })
  it('requires host capability and refuses WSL until the guest step, without host fallback', async () => {
    const f = fixture()
    expect(() => requireClaudeProfileRoutingCapability([])).toThrow('Update')
    await expect(f.routing.prepare({ runtime: 'wsl', wslDistro: 'Ubuntu' })).rejects.toThrow('WSL')
    expect(f.worker.prepare).not.toHaveBeenCalled()
    const second = fixture()
    second.settings.activeClaudeManagedAccountId = 'b'
    await second.routing.startup()
    expect(second.routing.resolve().configHome).not.toBe(f.routing.resolve().configHome)
  })
  it('distinguishes explicit default from missing, malformed and missing-directory pointers', () => {
    const f = fixture()
    const pointer = f.routing.pointerPath()
    expect(() => readClaudeProfilePointer(pointer)).toThrow()
    publishClaudeProfilePointer(pointer, null)
    expect(readClaudeProfilePointer(pointer)).toBe(null)
    for (const value of ['\n', '/missing-directory', 'relative', `${f.profiles[0].home}\n`]) {
      writeFileSync(pointer, value)
      expect(() => readClaudeProfilePointer(pointer)).toThrow()
    }
  })
  it('sets up a profile at select and startup, and at launch only when it never was', async () => {
    const f = fixture()
    await f.routing.prepare()
    expect(f.worker.prepare).toHaveBeenCalledTimes(1)
    mkdirSync(join(f.profiles[0].home, 'projects'))
    await f.routing.prepare()
    await f.routing.prepare()
    expect(f.worker.prepare).toHaveBeenCalledTimes(1)
    await f.routing.publish()
    expect(f.worker.prepare).toHaveBeenCalledTimes(2)
    f.worker.prepare.mockRejectedValue(new Error('Claude profile setup queue is full'))
    await expect(f.routing.publish()).resolves.toMatchObject({ configHome: f.profiles[0].home })
    f.settings.activeClaudeManagedAccountId = 'b'
    await expect(f.routing.prepare()).rejects.toThrow('queue is full')
    f.worker.prepare.mockResolvedValue({ outcome: 'refused', warnings: [], surfaces: {} })
    f.settings.activeClaudeManagedAccountId = 'a'
    await expect(f.routing.publish()).rejects.toThrow('could not be prepared')
  })
  it('lists every account without throwing and republishes a stale pointer in the background', async () => {
    const f = fixture()
    f.settings.claudeManagedAccounts.push({
      ...f.settings.claudeManagedAccounts[0],
      id: 'legacy'
    })
    const state = {
      accounts: f.settings.claudeManagedAccounts.map((account) => ({ ...account })),
      activeAccountId: 'a'
    }
    const listed = f.routing.describeAccounts(state)
    expect(listed.accounts.map((account) => account.profileReadiness)).toEqual([
      'ready',
      'ready',
      'sign-in-required'
    ])
    expect(listed.profileRoutingIssue).toBeDefined()
    await vi.waitFor(() =>
      expect(readClaudeProfilePointer(f.routing.pointerPath())).toBe(f.profiles[0].home)
    )
    expect(f.routing.describeAccounts(state).profileRoutingIssue).toBeUndefined()
    f.settings.activeClaudeManagedAccountId = 'legacy'
    expect(f.routing.describeAccounts(state).profileRoutingIssue).toBeDefined()
    await vi.waitFor(() =>
      expect(f.routing.describeAccounts(state).profileRoutingIssue).toContain(
        'Sign in again to use this account.'
      )
    )
  })
  it('gives panes the selected profile and a twin, and System Default nothing but the pointer', () => {
    const f = fixture()
    const pointer = { ORCA_CLAUDE_PROFILE_POINTER: f.routing.pointerPath() }
    expect(f.routing.terminalEnv()).toEqual({
      ...pointer,
      CLAUDE_CONFIG_DIR: f.profiles[0].home,
      ORCA_CLAUDE_INJECTED_CONFIG_DIR: f.profiles[0].home
    })
    f.settings.activeClaudeManagedAccountId = 'unknown'
    expect(f.routing.terminalEnv()).toEqual(pointer)
    f.settings.activeClaudeManagedAccountId = null
    expect(f.routing.terminalEnv()).toEqual(pointer)
    f.inherited.dir = join(f.root, 'user-own-claude')
    expect(f.routing.resolve().configHome).toBe(f.inherited.dir)
    expect(f.routing.historyRoots()[0]).toBe(f.inherited.dir)
    expect(f.routing.historyRoots()).toContain(join(f.home, '.claude'))
  })
  it('withdraws the pointer instead of leaving the previous account selected', async () => {
    const f = fixture()
    await f.routing.publish()
    rmSync(join(f.dataRoot, 'claude-profiles', 'a', 'profile.json'))
    await expect(f.routing.startup()).rejects.toThrow('Sign in again to use this account.')
    expect(existsSync(f.routing.pointerPath())).toBe(false)
    f.settings.activeClaudeManagedAccountId = 'b'
    await f.routing.publish()
    f.worker.prepare.mockResolvedValueOnce({ outcome: 'refused', warnings: [], surfaces: {} })
    await expect(f.routing.publish()).rejects.toThrow('could not be prepared')
    expect(existsSync(f.routing.pointerPath())).toBe(false)
    await f.routing.publish()
    f.worker.prepare.mockImplementationOnce(async () => {
      f.settings.activeClaudeManagedAccountId = null
      return { outcome: 'prepared', warnings: [], surfaces: {} }
    })
    await expect(f.routing.publish()).rejects.toThrow('changed')
    expect(readClaudeProfilePointer(f.routing.pointerPath())).toBe(f.profiles[1].home)
    await f.routing.publish()
    expect(readClaudeProfilePointer(f.routing.pointerPath())).toBe(null)
  })
  it('keeps a newer selection’s pointer when an overtaken publish fails', async () => {
    const f = fixture()
    const setup = Promise.withResolvers<ClaudeProfileSetupReport>()
    f.worker.prepare.mockImplementationOnce(() => setup.promise)
    const startup = f.routing.startup()
    f.settings.activeClaudeManagedAccountId = null
    await f.routing.publish()
    setup.reject(new Error('Claude profile setup timed out'))
    await expect(startup).rejects.toThrow('timed out')
    expect(readClaudeProfilePointer(f.routing.pointerPath())).toBe(null)
    expect(f.routing.describeAccounts({ accounts: [], activeAccountId: null })).not.toHaveProperty(
      'profileRoutingIssue'
    )
    mkdirSync(join(f.profiles[1].home, 'projects'))
    f.settings.activeClaudeManagedAccountId = 'a'
    const launchSetup = Promise.withResolvers<ClaudeProfileSetupReport>()
    f.worker.prepare.mockImplementationOnce(() => launchSetup.promise)
    const launch = f.routing.prepare()
    f.settings.activeClaudeManagedAccountId = 'b'
    await f.routing.publish()
    launchSetup.reject(new Error('Claude profile worker exited (1)'))
    await expect(launch).rejects.toThrow('exited')
    expect(readClaudeProfilePointer(f.routing.pointerPath())).toBe(f.profiles[1].home)
  })
  it('lets a launch and a select of the same account share one publish instead of failing', async () => {
    const f = fixture()
    const setup = Promise.withResolvers<ClaudeProfileSetupReport>()
    f.worker.prepare.mockImplementationOnce(() => setup.promise)
    const startup = f.routing.startup()
    const launch = f.routing.prepare()
    setup.resolve({ outcome: 'prepared', warnings: [], surfaces: {} })
    await expect(Promise.all([startup, launch])).resolves.toBeDefined()
    f.settings.activeClaudeManagedAccountId = 'b'
    const select = f.routing.publish()
    const overlapping = f.routing.prepare()
    await expect(select).resolves.toMatchObject({ configHome: f.profiles[1].home })
    await expect(overlapping).resolves.toMatchObject({ provenance: 'profile:b' })
    expect(readClaudeProfilePointer(f.routing.pointerPath())).toBe(f.profiles[1].home)
  })
  it('skill roots never fail for other providers when Claude cannot resolve', async () => {
    const f = fixture()
    const host = {
      getClaudeConfigDirectory: (
        target: { runtime: 'host' } | { runtime: 'wsl'; wslDistro: string }
      ) => f.routing.configDirOr(target, () => '/legacy-claude')
    }
    expect(host.getClaudeConfigDirectory({ runtime: 'host' })).toBe(f.profiles[0].home)
    expect(host.getClaudeConfigDirectory({ runtime: 'wsl', wslDistro: 'Ubuntu' })).toBe(
      '/legacy-claude'
    )
    f.settings.activeClaudeManagedAccountId = 'unknown'
    const roots = await resolveSkillProviderRoots(host, {
      scope: 'global',
      homeDirectory: f.home
    })
    expect(roots.claude).toBe(join('/legacy-claude', 'skills'))
  })
  it('System Default ignores a config dir an outer Orca injected', () => {
    expect(inheritedClaudeConfigDir({ CLAUDE_CONFIG_DIR: '/own' })).toBe('/own')
    expect(
      inheritedClaudeConfigDir({
        CLAUDE_CONFIG_DIR: '/outer/profile',
        ORCA_CLAUDE_INJECTED_CONFIG_DIR: '/outer/profile'
      })
    ).toBeNull()
    expect(inheritedClaudeConfigDir({})).toBeNull()
  })
})
