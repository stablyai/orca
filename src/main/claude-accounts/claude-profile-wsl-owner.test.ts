import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it, expect, vi, afterEach } from 'vitest'
import {
  createWslClaudeProfileOwner,
  withWslClaudeProfileOwner,
  type ClaudeProfileSettings
} from './claude-profile-wsl-owner'
import { ClaudeProfileRoutingService } from './claude-profile-routing-service'
import {
  ClaudeProfileHostUnreachableError,
  type ClaudeProfileRoutingOwner
} from './claude-profile-routing-owner'
import type { ClaudeWslProfileRequest } from './claude-profile-wsl-guest'
import type { ClaudeWslProfileResponse } from './claude-profile-wsl-transport'
import { mergeClaudeProfileReaderRoots } from './claude-profile-reader-roots'
import {
  CLAUDE_PROFILE_ROUTING_CAPABILITY,
  WSL_CLAUDE_PROFILE_POINTER,
  claudeProfileRoutingEnabled
} from '../../shared/claude-profile-routing'
import { toWindowsWslUncPath } from '../../shared/wsl-paths'
const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})
const ubuntu = { runtime: 'wsl' as const, wslDistro: 'Ubuntu' }
const profileHome = (distro: string, id: string) =>
  `/home/${distro}/.local/share/orca/claude-profiles/${id}/home`
// A current System Default host pointer, so describeAccounts reports only publish issues.
function hostOwner(): ClaudeProfileRoutingOwner {
  const root = mkdtempSync(join(tmpdir(), 'wsl-owner-host-'))
  roots.push(root)
  const pointerPath = join(root, 'selected')
  writeFileSync(pointerPath, '')
  const descriptor = {
    profile: null,
    configHome: root,
    readHome: root,
    defaultHome: root,
    pointerPath,
    target: { runtime: 'host' as const }
  }
  return {
    resolve: () => descriptor,
    pointerPath: () => pointerPath,
    targets: () => [{ runtime: 'host' }],
    readHomes: () => [],
    capabilities: () => [CLAUDE_PROFILE_ROUTING_CAPABILITY],
    isProvisioned: () => true,
    profileState: () => ({ readiness: 'unsupported', identity: null }),
    prepare: async () => ({ outcome: 'prepared', surfaces: {}, warnings: [] }),
    publish: async () => {},
    withdraw: () => {}
  }
}
function fixture(options: { withHost?: boolean } = {}) {
  const settings: ClaudeProfileSettings = {
    claudeManagedAccounts: ['Ubuntu', 'Debian'].map((distro) => ({
      id: distro,
      email: 'fake@example.test',
      authMethod: 'subscription-oauth',
      managedAuthRuntime: 'wsl',
      wslDistro: distro,
      managedAuthPath: '/unused-legacy',
      createdAt: 0,
      updatedAt: 0,
      lastAuthenticatedAt: 0
    })),
    activeClaudeManagedAccountId: null,
    activeClaudeManagedAccountIdsByRuntime: {
      host: null,
      wsl: { Ubuntu: 'Ubuntu', Debian: 'Debian' }
    },
    agentStatusHooksEnabled: false,
    disabledTuiAgents: []
  }
  const calls: ClaudeWslProfileRequest[] = []
  const respond = vi.fn(async (request: ClaudeWslProfileRequest) => ({
    ready: true,
    provisioned: true,
    readiness: Object.fromEntries<NonNullable<ClaudeWslProfileResponse['readiness']>[string]>(
      settings.claudeManagedAccounts.map((account) => [account.id, 'ready' as const])
    ),
    homes: [
      `/home/${request.distro}/.claude`,
      ...settings.claudeManagedAccounts
        .filter((account) => account.wslDistro === request.distro)
        .map((account) => profileHome(request.distro, account.id))
    ],
    historyHomes: { projects: [`/home/${request.distro}/.claude`], transcripts: [] },
    report: { outcome: 'prepared' as const, surfaces: {}, warnings: [] }
  }))
  const prepare = vi.fn(async (distro: string) => ({
    home: `/home/${distro}`,
    request: async (request: ClaudeWslProfileRequest) => {
      calls.push(request)
      return respond(request)
    }
  }))
  const reachable = vi.fn(async (_distro: string) => true)
  return {
    settings,
    prepare,
    respond,
    calls,
    reachable,
    routing: new ClaudeProfileRoutingService(
      (() => {
        const wsl = createWslClaudeProfileOwner(
          () => settings,
          prepare,
          async (distro) => {
            calls.push({
              action: 'withdraw',
              distro,
              userHome: `/home/${distro}`,
              accountId: null,
              hooksEnabled: false
            })
          },
          reachable,
          prepare
        )
        return options.withHost ? withWslClaudeProfileOwner(hostOwner(), wsl, () => settings) : wsl
      })()
    )
  }
}
it('keeps distro pointers, guest paths, startup and current selection separate', async () => {
  const f = fixture()
  await f.routing.startup()
  for (const distro of ['Ubuntu', 'Debian']) {
    const result = await f.routing.prepare({ runtime: 'wsl', wslDistro: distro })
    expect(result.envPatch.CLAUDE_CONFIG_DIR).toBe(
      `/home/${distro}/.local/share/orca/claude-profiles/${distro}/home`
    )
    expect(result.envPatch.ORCA_CLAUDE_PROFILE_POINTER).toBe(WSL_CLAUDE_PROFILE_POINTER)
    expect(result.configDir).toContain(`\\${distro}\\home\\${distro}`)
  }
  expect(f.calls.filter((request) => request.action === 'setup')).toHaveLength(2)
  expect(f.calls.filter((request) => request.action === 'publish')).toHaveLength(4)
  expect(claudeProfileRoutingEnabled()).toBe(true)
})
it('refuses runtime failure and withdraws only that distro pointer; retry can recover', async () => {
  const f = fixture()
  const target = { runtime: 'wsl' as const, wslDistro: 'Ubuntu' }
  await f.routing.prepare(target)
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 600_001)
  f.prepare.mockRejectedValueOnce(new Error('runtime download failed'))
  await expect(f.routing.prepare(target)).rejects.toThrow('runtime download failed')
  expect(f.calls.at(-1)).toMatchObject({ action: 'withdraw', distro: 'Ubuntu' })
  expect(() => f.routing.resolve(target)).toThrow('not verified')
  await expect(f.routing.prepare(target)).resolves.toHaveProperty('runtime', 'wsl')
})
it('rejects account/distro mismatches before touching a guest', async () => {
  const f = fixture()
  f.settings.activeClaudeManagedAccountIdsByRuntime!.wsl.Ubuntu = 'Debian'
  await expect(f.routing.prepare({ runtime: 'wsl', wslDistro: 'Ubuntu' })).rejects.toThrow(
    'does not belong'
  )
  expect(f.prepare).not.toHaveBeenCalled()
})
it('continues initializing other distros when one is stopped, then reports the failure', async () => {
  const f = fixture()
  f.prepare.mockRejectedValueOnce(new Error('Ubuntu is not running'))
  await expect(f.routing.startup()).rejects.toThrow('not running')
  expect(
    f.calls.some((request) => request.action === 'publish' && request.distro === 'Debian')
  ).toBe(true)
  expect(f.calls.some((request) => request.action === 'setup' && request.distro === 'Ubuntu')).toBe(
    false
  )
})
it('leaves a distro with no account unrouted, then routes the next pane once its first account is added', async () => {
  const f = fixture()
  const target = { runtime: 'wsl' as const, wslDistro: 'Arch' }
  expect(f.routing.routes(target)).toBe(false)
  expect(f.routing.terminalEnv(target)).toEqual({})
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(f.prepare.mock.calls.some(([distro]) => distro === 'Arch')).toBe(false)
  f.settings.claudeManagedAccounts.push({
    ...f.settings.claudeManagedAccounts[0],
    id: 'arch',
    wslDistro: 'Arch'
  })
  f.settings.activeClaudeManagedAccountIdsByRuntime!.wsl.Arch = 'arch'
  expect(f.routing.routes(target)).toBe(true)
  // The add flow publishes the distro as soon as its draft is registered.
  await f.routing.publish(target, 'always', 'boot')
  expect(f.calls.at(-1)).toMatchObject({ action: 'publish', distro: 'Arch', accountId: 'arch' })
  expect(f.routing.terminalEnv(target)).toMatchObject({
    ORCA_CLAUDE_PROFILE_POINTER: WSL_CLAUDE_PROFILE_POINTER
  })
  expect(f.routing.routes({ runtime: 'wsl', wslDistro: null })).toBe(false)
})
it('opens a routed WSL pane at once and re-derives its publish once the distro is up', async () => {
  const f = fixture({ withHost: true })
  const booting = Promise.withResolvers<boolean>()
  f.reachable.mockImplementationOnce(() => booting.promise)
  const pointer = { ORCA_CLAUDE_PROFILE_POINTER: WSL_CLAUDE_PROFILE_POINTER }
  expect(f.routing.terminalEnv(ubuntu)).toEqual(pointer)
  expect(f.routing.terminalEnv(ubuntu)).toEqual(pointer)
  // Why: no guest probe before the pane's own spawn has had time to boot the distro.
  expect(f.reachable).toHaveBeenCalledTimes(1)
  expect(f.prepare).not.toHaveBeenCalled()
  booting.resolve(false)
  await new Promise((resolve) => setTimeout(resolve, 0))
  // Still down after the wait: dropped silently and re-armed for the next pane.
  const issue = () =>
    f.routing.describeAccounts({ accounts: [], activeAccountId: null }).profileRoutingIssue
  expect(issue()).toBeUndefined()
  expect(f.prepare).not.toHaveBeenCalled()
  expect(f.routing.terminalEnv(ubuntu)).toEqual(pointer)
  expect(f.reachable).toHaveBeenCalledTimes(2)
  const home = profileHome('Ubuntu', 'Ubuntu')
  await vi.waitFor(() =>
    expect(f.routing.terminalEnv(ubuntu)).toEqual({
      ...pointer,
      CLAUDE_CONFIG_DIR: home,
      ORCA_CLAUDE_INJECTED_CONFIG_DIR: home
    })
  )
  expect(f.prepare).toHaveBeenCalledTimes(1)
  expect(f.calls.filter((call) => call.action === 'withdraw')).toHaveLength(0)
})
it('treats an unreachable distro as no answer: no issue and no pointer withdraw', async () => {
  const f = fixture({ withHost: true })
  f.prepare.mockRejectedValue(
    new ClaudeProfileHostUnreachableError('WSL distro Ubuntu is not running.')
  )
  await expect(f.routing.startup()).rejects.toThrow('not running')
  await expect(f.routing.prepare(ubuntu)).rejects.toThrow('not running')
  expect(
    f.routing.describeAccounts({ accounts: [], activeAccountId: null }).profileRoutingIssue
  ).toBeUndefined()
  expect(f.calls.filter((call) => call.action === 'withdraw')).toHaveLength(0)
})
it('lets a pane-triggered publish join a launch already publishing the distro', async () => {
  const f = fixture()
  const booting = Promise.withResolvers<boolean>()
  f.reachable.mockImplementationOnce(() => booting.promise)
  f.routing.terminalEnv(ubuntu)
  const launch = f.routing.prepare(ubuntu)
  booting.resolve(true)
  await launch
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(f.prepare).toHaveBeenCalledTimes(1)
  expect(f.calls.filter((call) => call.action === 'inspect')).toHaveLength(1)
})
it('keeps the newer selection verified when an older setup lands late', async () => {
  const f = fixture()
  f.settings.claudeManagedAccounts.push({ ...f.settings.claudeManagedAccounts[0], id: 'second' })
  const gate = Promise.withResolvers<void>()
  const respond = f.respond.getMockImplementation()
  f.respond.mockImplementation(async (request) => {
    if (request.action === 'setup' && request.accountId === 'Ubuntu') {
      await gate.promise
    }
    return respond!(request)
  })
  const older = f.routing.publish(ubuntu)
  await vi.waitFor(() =>
    expect(f.calls.some((call) => call.action === 'setup' && call.accountId === 'Ubuntu')).toBe(
      true
    )
  )
  f.settings.activeClaudeManagedAccountIdsByRuntime!.wsl.Ubuntu = 'second'
  await f.routing.publish(ubuntu)
  gate.resolve()
  await expect(older).rejects.toThrow('changed')
  expect(f.routing.resolve(ubuntu).profile?.accountId).toBe('second')
})
it('lets overlapping launches of the same WSL account share the newest publish', async () => {
  const f = fixture()
  const results = await Promise.allSettled([f.routing.prepare(ubuntu), f.routing.prepare(ubuntu)])
  expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled'])
})
it('clears a distro publication issue after removing its last account and publishing System Default', async () => {
  const f = fixture({ withHost: true })
  f.prepare.mockRejectedValueOnce(new Error('runtime download failed'))
  await expect(f.routing.prepare(ubuntu)).rejects.toThrow('runtime download failed')
  await expect(f.routing.prepare({ runtime: 'wsl', wslDistro: null })).rejects.toThrow(
    'specific WSL distro'
  )
  const issue = () =>
    f.routing.describeAccounts({ accounts: [], activeAccountId: null }).profileRoutingIssue
  expect(issue()).toBe('WSL Ubuntu: runtime download failed')
  f.settings.claudeManagedAccounts = f.settings.claudeManagedAccounts.filter(
    (account) => account.wslDistro !== 'Ubuntu'
  )
  f.settings.activeClaudeManagedAccountIdsByRuntime!.wsl.Ubuntu = null
  await f.routing.publish(ubuntu)
  expect(f.calls.at(-1)).toMatchObject({ action: 'publish', distro: 'Ubuntu', accountId: null })
  expect(issue()).toBeUndefined()
})
it('keeps a newer selection verified when an older inspect lands late', async () => {
  const f = fixture()
  f.settings.claudeManagedAccounts.push({ ...f.settings.claudeManagedAccounts[0], id: 'second' })
  const gate = Promise.withResolvers<void>()
  const respond = f.respond.getMockImplementation()
  f.respond.mockImplementation(async (request) => {
    if (request.action === 'inspect' && request.accountId === 'Ubuntu') {
      await gate.promise
    }
    return respond!(request)
  })
  const older = f.routing.publish(ubuntu)
  await vi.waitFor(() => expect(f.calls.map((call) => call.accountId)).toContain('Ubuntu'))
  f.settings.activeClaudeManagedAccountIdsByRuntime!.wsl.Ubuntu = 'second'
  await f.routing.publish(ubuntu)
  gate.resolve()
  await older.catch(() => {})
  expect(f.routing.resolve(ubuntu).profile?.accountId).toBe('second')
})
it('reports readiness for every owned WSL profile, not only the selected one', async () => {
  const f = fixture()
  f.settings.claudeManagedAccounts.push(
    { ...f.settings.claudeManagedAccounts[0], id: 'second' },
    { ...f.settings.claudeManagedAccounts[0], id: 'unowned' }
  )
  const respond = f.respond.getMockImplementation()
  f.respond.mockImplementation(async (request) => {
    const result = await respond!(request)
    return {
      ...result,
      readiness: { ...result.readiness, unowned: 'sign-in-required' as const },
      homes: result.homes.filter((home) => home !== profileHome('Ubuntu', 'unowned'))
    }
  })
  await f.routing.prepare(ubuntu)
  const readiness = f.routing
    .describeAccounts({
      accounts: f.settings.claudeManagedAccounts.map((account) => ({ ...account })),
      activeAccountId: null
    })
    .accounts.map((account) => [account.id, account.profileReadiness])
  expect(Object.fromEntries(readiness)).toEqual({
    Ubuntu: 'ready',
    second: 'ready',
    unowned: 'sign-in-required',
    // Not checked this session: background work never starts a stopped distro.
    Debian: 'unverified'
  })
})
it('sets a WSL profile up at launch only while the guest reports it unprovisioned', async () => {
  const f = fixture()
  const respond = f.respond.getMockImplementation()
  f.respond.mockImplementation(async (request) => ({
    ...(await respond!(request)),
    provisioned: request.action !== 'inspect'
  }))
  await f.routing.prepare(ubuntu)
  expect(f.calls.filter((call) => call.action === 'setup')).toHaveLength(1)
  f.respond.mockImplementation(async (request) => respond!(request))
  await f.routing.prepare(ubuntu)
  expect(f.calls.filter((call) => call.action === 'setup')).toHaveLength(1)
})
it('reads guest history roots per surface through the distro UNC path', async () => {
  const f = fixture()
  await f.routing.prepare(ubuntu)
  expect(f.routing.historyRoots(ubuntu, 'projects')).toEqual([
    toWindowsWslUncPath('/home/Ubuntu/.claude', 'Ubuntu')
  ])
  expect(f.routing.historyRoots(ubuntu, 'transcripts')).toEqual([])
  expect(f.routing.historyRoots(undefined)).toEqual([
    toWindowsWslUncPath('/home/Ubuntu/.claude', 'Ubuntu'),
    toWindowsWslUncPath(profileHome('Ubuntu', 'Ubuntu'), 'Ubuntu')
  ])
})
it('reuses a prepared guest for ten minutes, then prepares it again', async () => {
  const f = fixture()
  await f.routing.prepare(ubuntu)
  await f.routing.prepare(ubuntu)
  expect(f.prepare).toHaveBeenCalledTimes(1)
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 600_001)
  await f.routing.prepare(ubuntu)
  expect(f.prepare).toHaveBeenCalledTimes(2)
})
it('prepares the guest again after a failed request instead of reusing it', async () => {
  const f = fixture()
  await f.routing.prepare(ubuntu)
  f.respond.mockRejectedValueOnce(new Error('guest runtime unavailable'))
  await expect(f.routing.prepare(ubuntu)).rejects.toThrow('guest runtime unavailable')
  await f.routing.prepare(ubuntu)
  expect(f.prepare).toHaveBeenCalledTimes(2)
})
it('admits a guest UNC history root verbatim beside the legacy roots', () => {
  const guest = toWindowsWslUncPath(
    '/home/u/.local/share/orca/claude-profiles/a/home/projects',
    'Ubuntu'
  )
  expect(mergeClaudeProfileReaderRoots(['/legacy/projects'], [guest, guest])).toEqual([
    '/legacy/projects',
    guest
  ])
})

it('publishes System Default in a routed distro without the managed guest runtime', async () => {
  const f = fixture()
  f.settings.activeClaudeManagedAccountIdsByRuntime!.wsl.Ubuntu = null
  const prepareGuest = vi.fn(async (): Promise<never> => {
    throw new Error('Pinned guest runtime could not be prepared')
  })
  const routing = new ClaudeProfileRoutingService(
    createWslClaudeProfileOwner(
      () => f.settings,
      prepareGuest,
      async () => {},
      f.reachable,
      f.prepare
    )
  )
  await expect(routing.publish(ubuntu, 'always', 'boot')).resolves.toMatchObject({ profile: null })
  expect(f.calls.at(-1)).toMatchObject({ action: 'publish', distro: 'Ubuntu', accountId: null })
  // A runtime failure never blocks choosing System Default, and leaves no routing issue behind.
  expect(
    routing.describeAccounts({ accounts: [], activeAccountId: null }).profileRoutingIssue ?? ''
  ).not.toContain('Ubuntu')
})

it('shows an upgraded WSL account as needing sign-in once selecting it has checked the distro', async () => {
  const f = fixture()
  const debian = { runtime: 'wsl' as const, wslDistro: 'Debian' }
  const readinessOf = () =>
    f.routing
      .describeAccounts({
        accounts: f.settings.claudeManagedAccounts.map((account) => ({ ...account })),
        activeAccountId: null
      })
      .accounts.find((account) => account.id === 'Debian')?.profileReadiness
  expect(readinessOf()).toBe('unverified')
  const respond = f.respond.getMockImplementation()!
  f.respond.mockImplementation(async (request) => {
    const result = await respond(request)
    return request.distro === 'Debian'
      ? { ...result, ready: false, readiness: { Debian: 'sign-in-required' as const } }
      : result
  })
  await expect(f.routing.publish(debian, 'always', 'boot')).rejects.toThrow(
    'Sign in again to use this account.'
  )
  expect(readinessOf()).toBe('sign-in-required')
})

function routingFixture(withAccount: boolean) {
  const settings: ClaudeProfileSettings = {
    claudeManagedAccounts: withAccount
      ? [
          {
            id: 'a',
            email: 'a@example.test',
            authMethod: 'subscription-oauth',
            managedAuthRuntime: 'wsl',
            wslDistro: 'Ubuntu',
            managedAuthPath: '/unused',
            createdAt: 0,
            updatedAt: 0,
            lastAuthenticatedAt: 0
          }
        ]
      : [],
    activeClaudeManagedAccountId: null,
    activeClaudeManagedAccountIdsByRuntime: {
      host: null,
      wsl: { Ubuntu: withAccount ? 'a' : null }
    },
    agentStatusHooksEnabled: false,
    disabledTuiAgents: []
  }
  const calls: ClaudeWslProfileRequest[] = []
  const guest = (distro: string) => ({
    home: `/home/${distro}`,
    request: async (request: ClaudeWslProfileRequest) => {
      calls.push(request)
      return {
        ready: true,
        provisioned: true,
        readiness: Object.fromEntries(
          settings.claudeManagedAccounts.map((a) => [a.id, 'ready' as const])
        ),
        homes: [],
        historyHomes: { projects: [], transcripts: [] },
        report: { outcome: 'prepared' as const, surfaces: {}, warnings: [] }
      }
    }
  })
  const prepare = vi.fn(async (distro: string) => guest(distro))
  const prepareDefault = vi.fn(async (distro: string) => guest(distro))
  const withdraw = vi.fn(async () => {})
  const owner = createWslClaudeProfileOwner(
    () => settings,
    prepare,
    withdraw,
    async () => true,
    prepareDefault
  )
  return {
    settings,
    prepare,
    prepareDefault,
    withdraw,
    owner,
    calls,
    routing: new ClaudeProfileRoutingService(owner)
  }
}

it('unroutes a distro once its last account is removed', async () => {
  const f = routingFixture(true)
  await f.routing.publish(ubuntu, 'always', 'boot')
  f.settings.claudeManagedAccounts = []
  f.settings.activeClaudeManagedAccountIdsByRuntime!.wsl.Ubuntu = null
  expect(f.routing.routes(ubuntu)).toBe(false)
  expect(f.routing.terminalEnv(ubuntu)).toEqual({})
})
it('leaves open panes on System Default, not refusing, once the last account is removed', async () => {
  const f = routingFixture(true)
  await f.routing.publish(ubuntu, 'always', 'boot')
  f.settings.claudeManagedAccounts = []
  f.settings.activeClaudeManagedAccountIdsByRuntime!.wsl.Ubuntu = null
  f.calls.length = 0
  await f.routing.retire(ubuntu, 'boot')
  expect(f.withdraw).not.toHaveBeenCalled()
  expect(f.prepareDefault).toHaveBeenCalledWith('Ubuntu', 'boot')
  expect(f.calls).toEqual([expect.objectContaining({ action: 'publish', accountId: null })])
})
it('leaves a distro unrouted after a failed first Add forgets its draft', async () => {
  const f = routingFixture(false)
  f.settings.claudeManagedAccounts = [
    {
      id: 'd',
      email: '',
      authMethod: 'unknown',
      managedAuthRuntime: 'wsl',
      wslDistro: 'Ubuntu',
      managedAuthPath: '',
      createdAt: 0,
      updatedAt: 0,
      lastAuthenticatedAt: 0
    }
  ]
  await f.routing.publish(ubuntu, 'always', 'boot')
  f.settings.claudeManagedAccounts = []
  expect(f.routing.routes(ubuntu)).toBe(false)
  expect(f.routing.terminalEnv(ubuntu)).toEqual({})
})
it('does not retry a failed managed guest for every System Default launch', async () => {
  const f = routingFixture(true)
  f.prepare.mockRejectedValue(new Error('runtime download failed'))
  await expect(f.routing.publish(ubuntu, 'always', 'boot')).rejects.toThrow(
    'runtime download failed'
  )
  expect(f.prepareDefault).not.toHaveBeenCalled()
  f.settings.activeClaudeManagedAccountIdsByRuntime!.wsl.Ubuntu = null
  await expect(f.routing.publish(ubuntu, 'always', 'boot')).resolves.toMatchObject({
    profile: null
  })
  const before = f.prepare.mock.calls.length
  await f.routing.publish(ubuntu, 'if-missing', 'boot')
  await f.routing.publish(ubuntu, 'if-missing', 'boot')
  expect(f.prepare.mock.calls.length).toBe(before)
  // Selecting the managed account again still tries its own guest.
  f.settings.activeClaudeManagedAccountIdsByRuntime!.wsl.Ubuntu = 'a'
  await expect(f.routing.publish(ubuntu, 'always', 'boot')).rejects.toThrow(
    'runtime download failed'
  )
  expect(f.prepare.mock.calls.length).toBe(before + 1)
})
it('observes a finished sign-in through the managed guest even after a System Default fallback', async () => {
  const f = routingFixture(true)
  f.settings.activeClaudeManagedAccountIdsByRuntime!.wsl.Ubuntu = null
  f.prepare.mockRejectedValueOnce(new Error('runtime download failed'))
  await f.routing.publish(ubuntu, 'always', 'boot')
  const before = f.prepare.mock.calls.length
  await f.routing.refreshForRead(ubuntu, { managedGuest: true })
  expect(f.prepare.mock.calls.length).toBe(before + 1)
  expect(f.routing.observedIdentity('a')).toBeNull()
})
