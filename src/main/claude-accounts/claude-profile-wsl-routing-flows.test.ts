import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type * as NodeOs from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { WslResult, WslSpec } from '../wsl/wsl-runner'
import { WSL_CLAUDE_PROFILE_HELPER_FILENAME } from '../../shared/relay-artifacts'
import type { ClaudeProfileRoutingOwner } from './claude-profile-routing-owner'
import type { ClaudeProfileRoutingService } from './claude-profile-routing-service'
import {
  cleanupRuntimeAuthTestState,
  createClaudeAccount,
  createElectronMock,
  createKeychainMock,
  createOauthRefreshMock,
  createSettings,
  createStore,
  resetRuntimeAuthTestState,
  setPlatform,
  testState
} from './runtime-auth-service-test-harness'

// Real routing service, WSL owner and transport; only wsl.exe, the running probe, the runtime
// ensure and the bundle dir are faked.
const mocks = vi.hoisted(() => {
  const state: {
    root: string
    running: boolean
    exists: boolean
    runningChecks: number
    authority?: ClaudeProfileRoutingService
    /** A stopped distro finishes booting when this settles. */
    boot?: Promise<void>
  } = { root: '', running: true, exists: true, runningChecks: 0 }
  return {
    state,
    run: vi.fn<(spec: WslSpec) => Promise<WslResult>>(),
    runtime: vi.fn()
  }
})
vi.mock('electron', () => createElectronMock())
vi.mock('./oauth-refresh', () => createOauthRefreshMock())
vi.mock('./keychain', () => createKeychainMock())
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeOs>()),
  homedir: () => testState.fakeHomeDir
}))
vi.mock('../../shared/app-environment', () => ({
  getAppEnvironment: () => ({
    getAppPath: () => mocks.state.root,
    getPath: () => mocks.state.root
  })
}))
vi.mock('../wsl/wsl-relay-bundle-dirs', () => ({ wslRelayBundleDirs: () => [mocks.state.root] }))
vi.mock('../wsl-running-path-filter', () => ({
  filterPathsToRunningWslDistrosAsync: async (paths: string[]) => {
    mocks.state.runningChecks += 1
    return mocks.state.running ? paths : []
  }
}))
vi.mock('../wsl/wsl-runner', () => ({ runWslProcess: mocks.run }))
vi.mock('../wsl/wsl-pinned-runtime', () => ({ ensureWslPinnedRuntime: mocks.runtime }))
vi.mock('./claude-profile-routing-authority', () => ({
  getClaudeProfileRoutingAuthority: () => mocks.state.authority,
  installClaudeProfileRoutingAuthority: () => {}
}))

const ubuntu = { runtime: 'wsl' as const, wslDistro: 'Ubuntu' }
const rmCalls = () => mocks.run.mock.calls.filter(([spec]) => spec.script?.includes('rm -f'))
const helperActions = () =>
  mocks.run.mock.calls
    .filter(([spec]) => spec.program === '/usr/bin/env')
    .map(([spec]) => JSON.parse(spec.input ?? '{}').action)
const issue = (routing: ClaudeProfileRoutingService) =>
  routing.describeAccounts({ accounts: [], activeAccountId: null }).profileRoutingIssue

function hostOwner(root: string): ClaudeProfileRoutingOwner {
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
    capabilities: () => ['claude.profile-routing.v1'],
    isProvisioned: () => true,
    readiness: () => 'unsupported',
    prepare: async () => ({ outcome: 'prepared', surfaces: {}, warnings: [] }),
    publish: async () => {},
    withdraw: async () => {}
  }
}

async function routingFor(settings: () => GlobalSettings): Promise<ClaudeProfileRoutingService> {
  const { ClaudeProfileRoutingService } = await import('./claude-profile-routing-service')
  const { createWslClaudeProfileOwner, withWslClaudeProfileOwner } =
    await import('./claude-profile-wsl-owner')
  return new ClaudeProfileRoutingService(
    withWslClaudeProfileOwner(
      hostOwner(mocks.state.root),
      createWslClaudeProfileOwner(settings),
      settings
    )
  )
}

const ubuntuSettings = () =>
  createSettings({
    claudeManagedAccounts: [
      createClaudeAccount('u1', join(mocks.state.root, 'u1'), {
        managedAuthRuntime: 'wsl',
        wslDistro: 'Ubuntu'
      })
    ],
    activeClaudeManagedAccountIdsByRuntime: { host: null, wsl: { Ubuntu: 'u1' } }
  })

beforeEach(() => {
  resetRuntimeAuthTestState()
  mocks.state.root = mkdtempSync(join(tmpdir(), 'wsl-routing-flows-'))
  mocks.state.running = true
  mocks.state.exists = true
  mocks.state.boot = undefined
  mocks.state.runningChecks = 0
  mocks.state.authority = undefined
  // Why: like `wsl -d <distro> --exec`, any guest command boots a stopped distro that exists.
  mocks.run.mockReset().mockImplementation(async (spec) => {
    if (!mocks.state.exists) {
      // wsl.exe's own failure: exit 0xFFFFFFFF, empty stderr, the diagnostic on stdout.
      return {
        code: 0xffffffff,
        stdout:
          'There is no distribution with the supplied name.\r\nError code: Wsl/Service/WSL_E_DISTRO_NOT_FOUND\r\n',
        stderr: '',
        timedOut: false,
        environmentResolved: true
      }
    }
    if (!mocks.state.running) {
      await mocks.state.boot
    }
    mocks.state.running = true
    return guestAnswer(spec)
  })
  mocks.runtime.mockReset().mockImplementation(async (run) => {
    for (const program of ['uname', 'getconf', 'printf', 'probe']) {
      await run({ program, loginPath: 'none' })
    }
    return { executable: '/home/fake/node', home: '/home/fake' }
  })
  writeFileSync(join(mocks.state.root, WSL_CLAUDE_PROFILE_HELPER_FILENAME), 'FAKE BUNDLE')
})
function guestAnswer(spec: WslSpec): WslResult {
  return {
    code: 0,
    stdout:
      spec.program === '/usr/bin/env'
        ? JSON.stringify({
            ready: true,
            provisioned: true,
            homes: ['/home/fake/.claude'],
            historyHomes: { projects: [], transcripts: [] },
            report: { outcome: 'prepared', surfaces: {}, warnings: [] }
          })
        : '/mnt/c/fake-helper.cjs',
    stderr: '',
    timedOut: false,
    environmentResolved: true
  }
}
afterEach(() => {
  vi.useRealTimers()
  cleanupRuntimeAuthTestState()
  rmSync(mocks.state.root, { recursive: true, force: true })
})

describe('a WSL distro stopped when Orca starts', () => {
  it('republishes after the pane boots it, never withdrawing or latching an issue', async () => {
    vi.useFakeTimers()
    const settings = ubuntuSettings()
    const routing = await routingFor(() => settings)
    mocks.state.running = false
    await expect(routing.startup()).rejects.toThrow('not running')
    expect(issue(routing)).toBeUndefined()
    const before = mocks.state.runningChecks
    routing.terminalEnv(ubuntu)
    // No probe before the pane's own wsl.exe has had a turn to boot the distro.
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.state.runningChecks).toBe(before)
    mocks.state.running = true
    await vi.advanceTimersByTimeAsync(1_000)
    expect(helperActions()).toEqual(['inspect', 'publish'])
    expect(rmCalls()).toHaveLength(0)
    expect(issue(routing)).toBeUndefined()
    expect(routing.terminalEnv(ubuntu)).toHaveProperty('CLAUDE_CONFIG_DIR')
  })

  it('drops the repair silently while the distro stays stopped, and re-arms it', async () => {
    vi.useFakeTimers()
    const settings = ubuntuSettings()
    const routing = await routingFor(() => settings)
    mocks.state.running = false
    routing.terminalEnv(ubuntu)
    routing.terminalEnv(ubuntu)
    await vi.advanceTimersByTimeAsync(7_000)
    expect(mocks.state.runningChecks).toBe(3)
    expect(mocks.run).not.toHaveBeenCalled()
    expect(issue(routing)).toBeUndefined()
    routing.terminalEnv(ubuntu)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(mocks.state.runningChecks).toBe(4)
  })
})

describe('a WSL Claude launch in a distro with no publish yet', () => {
  it('prepares the guest once: the pane repair joins the launch', async () => {
    vi.useFakeTimers()
    const settings = ubuntuSettings()
    const routing = await routingFor(() => settings)
    routing.terminalEnv(ubuntu)
    await routing.prepare(ubuntu)
    await vi.advanceTimersByTimeAsync(7_000)
    // Before the join: 2 runtime ensures, 13 guest runs and 5 running checks for this launch.
    // A launch may boot its distro, so only the pane's background wait probes.
    expect(mocks.runtime).toHaveBeenCalledTimes(1)
    expect(helperActions()).toEqual(['inspect', 'publish'])
    expect({
      wslRuns: mocks.run.mock.calls.length,
      runningChecks: mocks.state.runningChecks
    }).toEqual({ wslRuns: 7, runningChecks: 1 })
  })
})

async function userFlows(settings: GlobalSettings, profileMode: boolean) {
  setPlatform('win32')
  const store = createStore(settings)
  if (profileMode) {
    mocks.state.authority = await routingFor(() => store.getSettings())
  }
  const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
  const { ClaudeAccountSelection } = await import('./claude-account-selection')
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the harness store implements the getSettings/updateSettings pair these classes use.
  const runtimeAuth = new ClaudeRuntimeAuthService(store as never)
  const removeManagedAuth = vi.fn(async () => {})
  const selection = new ClaudeAccountSelection(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: as above.
    store as never,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: select() and remove() call only these two rate-limit members.
    {
      evictInactiveClaudeCache: vi.fn(),
      refreshForClaudeAccountChange: vi.fn(async () => {})
    } as never,
    runtimeAuth,
    removeManagedAuth
  )
  // Why: settle the constructor's startup publish before the distro idles.
  await new Promise((resolve) => setTimeout(resolve, 0))
  return { store, runtimeAuth, selection, removeManagedAuth }
}

const twoAccountSettings = () =>
  createSettings({
    claudeManagedAccounts: ['u1', 'u2'].map((id) =>
      createClaudeAccount(id, join(mocks.state.root, id), {
        managedAuthRuntime: 'wsl',
        wslDistro: 'Ubuntu'
      })
    ),
    activeClaudeManagedAccountIdsByRuntime: { host: null, wsl: { Ubuntu: 'u1' } }
  })

describe('user-initiated work on an idle-stopped routed distro boots it', () => {
  it('launches Claude', async () => {
    const flows = await userFlows(ubuntuSettings(), true)
    mocks.state.running = false
    await expect(flows.runtimeAuth.prepareForClaudeLaunch(ubuntu)).resolves.toMatchObject({
      provenance: 'profile:u1'
    })
    expect(mocks.state.running).toBe(true)
  })

  it('selects another account', async () => {
    const flows = await userFlows(twoAccountSettings(), true)
    mocks.state.running = false
    await flows.selection.select('u2', ubuntu)
    expect(helperActions().at(-1)).toBe('publish')
    expect(mocks.state.authority?.resolve(ubuntu).profile?.accountId).toBe('u2')
  })

  it('removes a selected account that is not the last', async () => {
    const flows = await userFlows(twoAccountSettings(), true)
    mocks.state.running = false
    await flows.selection.remove('u1')
    expect(flows.store.getSettings().claudeManagedAccounts.map((account) => account.id)).toEqual([
      'u2'
    ])
    expect(helperActions().at(-1)).toBe('publish')
  })

  it('retires the last selected account by booting the distro to delete its pointer', async () => {
    const flows = await userFlows(ubuntuSettings(), true)
    const retire = vi.spyOn(mocks.state.authority!, 'retire')
    mocks.state.running = false
    const before = helperActions().length
    await flows.selection.remove('u1')
    expect(flows.store.getSettings().claudeManagedAccounts).toEqual([])
    expect(retire).toHaveBeenCalledWith(ubuntu, 'boot')
    expect(rmCalls()).toHaveLength(1)
    expect(helperActions()).toHaveLength(before)
    expect(flows.removeManagedAuth).toHaveBeenCalledTimes(1)
  })

  it("refuses a launch into a distro that does not exist with wsl.exe's own reason", async () => {
    const flows = await userFlows(ubuntuSettings(), true)
    mocks.state.exists = false
    mocks.state.running = false
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = await flows.runtimeAuth.prepareForClaudeLaunch(ubuntu).catch((caught) => caught)
    // Why by name: the harness resets modules, so this file's class is a different instance.
    expect(error).toHaveProperty('name', 'ClaudeProfileHostMissingError')
    expect(String(error)).toContain(
      'There is no distribution with the supplied name.\r\nError code: Wsl/Service/WSL_E_DISTRO_NOT_FOUND'
    )
  })

  it('removes accounts of a distro that no longer exists, but still refuses selecting there', async () => {
    const flows = await userFlows(twoAccountSettings(), true)
    mocks.state.exists = false
    mocks.state.running = false
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(flows.selection.select(null, ubuntu)).rejects.toThrow('There is no distribution')
    await flows.selection.remove('u2')
    await flows.selection.remove('u1')
    expect(flows.store.getSettings().claudeManagedAccounts).toEqual([])
    expect(flows.removeManagedAuth).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalledWith(
      '[claude-accounts] Removed an account of a WSL distro that no longer exists:',
      expect.objectContaining({ name: 'ClaudeProfileHostMissingError' })
    )
  })

  it('lets a launch booting the distro finish when startup reaches the same distro', async () => {
    const settings = ubuntuSettings()
    const routing = await routingFor(() => settings)
    mocks.state.running = false
    const booted = Promise.withResolvers<void>()
    mocks.state.boot = booted.promise
    const launch = routing.prepare(ubuntu)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const startup = routing.startup()
    booted.resolve()
    await expect(launch).resolves.toMatchObject({ provenance: 'profile:u1' })
    await startup
    expect(helperActions()).toEqual(['inspect', 'publish'])
  })

  it('never boots the distro from startup', async () => {
    mocks.state.running = false
    const flows = await userFlows(ubuntuSettings(), true)
    expect(flows).toBeDefined()
    expect(mocks.run).not.toHaveBeenCalled()
  })

  it('removes the last selected account with the gate off exactly as before', async () => {
    const flows = await userFlows(ubuntuSettings(), false)
    mocks.state.running = false
    await flows.selection.remove('u1')
    expect(flows.store.getSettings().claudeManagedAccounts).toEqual([])
    expect(mocks.run).not.toHaveBeenCalled()
  })
})
