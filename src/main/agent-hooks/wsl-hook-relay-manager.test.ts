import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RelayDispatcher } from '../../wsl-guest/dispatcher'
import { registerWslHookFsHandlers } from '../../wsl-guest/wsl-hook-fs-bridge'
import { SshChannelMultiplexer, type MultiplexerTransport } from '../ssh/ssh-channel-multiplexer'
import { createWslHookSftpAdapter } from './wsl-hook-fs-adapter'
import {
  installRemoteManagedAgentHooks,
  REMOTE_MANAGED_HOOK_INSTALLER_AGENTS
} from './remote-managed-hook-installers'
import { WslHookRelayManager } from './wsl-hook-relay-manager'
import { CLAUDE_AGENT_VIEW_RELAY_METHOD } from '../../shared/claude-agent-view'
import { awaitExplicitAgentPluginGuestReadiness } from './wsl-agent-plugin-readiness'
import { FAILURE_COOLDOWN_BASE_MS, type WslHookRelayManagerDeps } from './wsl-hook-relay-deps'
import {
  AGENT_HOOK_INSTALL_PLUGINS_METHOD,
  AGENT_HOOK_NOTIFICATION_METHOD,
  AGENT_HOOK_REQUEST_REPLAY_METHOD
} from '../../shared/agent-hook-relay'

type GuestHarness = {
  transport: MultiplexerTransport
  guestDispatcher: RelayDispatcher
  mux: SshChannelMultiplexer
}

/** Connect a host mux to a guest dispatcher through in-memory stdio. */
function createGuestHarness(): GuestHarness {
  let relayFeed: ((data: Buffer) => void) | undefined
  const clientDataCallbacks: ((data: Buffer) => void)[] = []
  const closeCallbacks: (() => void)[] = []
  const transport: MultiplexerTransport = {
    write: (data, onSettled) => {
      setImmediate(() => {
        relayFeed?.(data)
        onSettled?.({ ok: true })
      })
    },
    supportsWriteSettlement: true,
    onData: (cb) => {
      clientDataCallbacks.push(cb)
    },
    onClose: (cb) => {
      closeCallbacks.push(cb)
    }
  }
  const guestDispatcher = new RelayDispatcher(
    (data: Buffer, onSettled) => {
      setImmediate(() => {
        for (const cb of clientDataCallbacks) {
          cb(data)
        }
        onSettled({ ok: true })
      })
    },
    { supportsWriteCallback: true }
  )
  relayFeed = (data) => guestDispatcher.feed(data)
  const mux = new SshChannelMultiplexer(transport)
  return { transport, guestDispatcher, mux }
}

// The filesystem bridge executes inside a POSIX guest.
describe.skipIf(process.platform === 'win32')(
  'createWslHookSftpAdapter over the guest fs bridge',
  () => {
    let home: string
    let harness: GuestHarness

    beforeEach(() => {
      home = mkdtempSync(join('/tmp', 'wsl-guest-home-'))
      harness = createGuestHarness()
      registerWslHookFsHandlers(harness.guestDispatcher, home)
    })

    afterEach(() => {
      harness.mux.dispose()
      harness.guestDispatcher.dispose()
      rmSync(home, { recursive: true, force: true })
    })

    it('maps guest ENOENT onto ssh2 status code 2', async () => {
      const adapter = createWslHookSftpAdapter(harness.mux)
      const err = await new Promise<Error & { code?: number }>((resolve) => {
        adapter.readFile(`${home}/missing.json`, 'utf8', ((e: Error) => resolve(e)) as never)
      })
      expect(err).toBeInstanceOf(Error)
      expect(err.code).toBe(2)
    })

    it('round-trips write/read/rename and rejects paths outside home', async () => {
      const adapter = createWslHookSftpAdapter(harness.mux)
      await new Promise<void>((resolve, reject) => {
        adapter.writeFile(
          `${home}/a.txt`,
          'hello',
          { encoding: 'utf8', mode: 0o600 } as never,
          ((e: Error | null) => (e ? reject(e) : resolve())) as never
        )
      })
      const content = await new Promise<string>((resolve, reject) => {
        adapter.readFile(`${home}/a.txt`, 'utf8', ((e: Error | null, value: string) =>
          e ? reject(e) : resolve(value)) as never)
      })
      expect(content).toBe('hello')

      await new Promise<void>((resolve, reject) => {
        adapter.ext_openssh_rename(`${home}/a.txt`, `${home}/b.txt`, ((e: Error | null) =>
          e ? reject(e) : resolve()) as never)
      })
      expect(existsSync(`${home}/b.txt`)).toBe(true)

      const outside = await new Promise<Error & { code?: number }>((resolve) => {
        adapter.readFile('/etc/passwd', 'utf8', ((e: Error) => resolve(e)) as never)
      })
      expect(outside).toBeInstanceOf(Error)
    })

    it('runs the unchanged remote managed hook installers against a WSL guest home', async () => {
      const adapter = createWslHookSftpAdapter(harness.mux)
      const results = await installRemoteManagedAgentHooks(adapter, home, {
        agents: REMOTE_MANAGED_HOOK_INSTALLER_AGENTS
      })

      expect(results.length).toBeGreaterThan(0)
      expect(results.every((r) => r.state !== 'error')).toBe(true)

      const claudeSettings = JSON.parse(
        readFileSync(join(home, '.claude', 'settings.json'), 'utf8')
      )
      expect(claudeSettings.hooks).toBeTruthy()
      const script = readFileSync(join(home, '.orca', 'agent-hooks', 'claude-hook.sh'), 'utf8')
      expect(script).toContain('/hook/claude')
    }, 20_000)
  }
)

describe('WslHookRelayManager', () => {
  // Mocked installers touch no disk, so a fixed POSIX guest home also works on Windows.
  const home = '/home/wsl-test-user'
  const codexHome =
    '\\\\wsl.localhost\\Ubuntu\\home\\wsl-test-user\\.local\\share\\orca\\codex-runtime-home\\home'
  const opencodeOverlayDir = `${home}/.orca-relay/opencode-overlays/deadbeefcafe`
  const opencode2OverlayDir = `${home}/.orca-relay/opencode2-overlays/deadbeefcafe`
  let harnesses: GuestHarness[]

  beforeEach(() => {
    harnesses = []
  })

  afterEach(() => {
    for (const h of harnesses) {
      h.mux.dispose()
      h.guestDispatcher.dispose()
    }
  })

  function fakeChild(): ChildProcessWithoutNullStreams & { emitClose: () => void } {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter
      stderr: EventEmitter
      stdin: { write: () => boolean; end: () => void; on: () => void }
      kill: () => void
      emitClose: () => void
    }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.stdin = { write: () => true, end: () => {}, on: () => {} }
    child.kill = () => {}
    child.emitClose = () => child.emit('close', 0)
    return child as unknown as ChildProcessWithoutNullStreams & { emitClose: () => void }
  }

  function guestTransport(
    options: {
      registerInstallPlugins?: boolean
      detectedAgents?: string[]
      claudeVersion?: string
      claudePluginDir?: string
    } = {}
  ): MultiplexerTransport {
    const { registerInstallPlugins = true, detectedAgents = ['codex'], claudeVersion } = options
    const harness = createGuestHarness()
    harnesses.push(harness)
    registerWslHookFsHandlers(harness.guestDispatcher, home)
    harness.guestDispatcher.onRequest(AGENT_HOOK_REQUEST_REPLAY_METHOD, async () => ({
      replayed: 0
    }))
    harness.guestDispatcher.onRequest('preflight.detectAgents', async () => ({
      agents: detectedAgents,
      ...(claudeVersion ? { versions: { claude: claudeVersion } } : {})
    }))
    // A guest bundle predating the plugin overlay omits this handler (-32601).
    if (registerInstallPlugins) {
      harness.guestDispatcher.onRequest(AGENT_HOOK_INSTALL_PLUGINS_METHOD, async (params) => ({
        installed: { opencode: true, opencode2: true, pi: false, omp: false },
        overlayDirs: {
          opencode: opencodeOverlayDir,
          opencode2: opencode2OverlayDir,
          pi: `${home}/.pi/agent`,
          omp: `${home}/.omp/agent/extensions/orca-agent-status.ts`,
          ...(options.claudePluginDir && params?.claudeAgentViewSource
            ? { claudeAgentView: options.claudePluginDir, claudeConfig: `${home}/.claude` }
            : {})
        }
      }))
    }
    return harness.transport
  }

  function startupError(code: number | null, stderr = ''): Error {
    return Object.assign(new Error(`exit ${code}`), {
      startup: { kind: 'exit' as const, code, stderr }
    })
  }

  function createManager(overrides: Partial<WslHookRelayManagerDeps>): {
    manager: WslHookRelayManager
    deps: WslHookRelayManagerDeps
  } {
    const deps: WslHookRelayManagerDeps = {
      platform: () => 'win32',
      remoteHooksEnabled: () => true,
      hookCoordsEnv: () => ({
        ORCA_AGENT_HOOK_PORT: '43117',
        ORCA_AGENT_HOOK_TOKEN: 'tok',
        ORCA_AGENT_HOOK_ENV: 'production',
        ORCA_AGENT_HOOK_VERSION: '1'
      }),
      instanceKey: () => 'testinstance',
      resolveBundle: () => ({ jsPath: '/fake/wsl-agent-hook-relay.js', version: '0.1.0+abc' }),
      readBundle: () => Buffer.from('// bundle'),
      listDistros: async () => ['Ubuntu'],
      isDistroRunning: vi.fn(async () => true),
      spawnRelay: vi.fn(() => fakeChild()),
      runInstall: vi.fn(async () => ({ code: 0, stderr: '' })),
      waitForSentinel: vi.fn(async () => guestTransport()),
      ingest: vi.fn(),
      installHooks: vi.fn(async () => []),
      installCodex: vi.fn(async () => ({
        agent: 'codex' as const,
        state: 'installed' as const,
        configPath: `${home}/.local/share/orca/codex-runtime-home/home/hooks.json`,
        managedHooksPresent: true,
        detail: null
      })),
      managedHookSettings: () => null,
      pluginSources: () => ({ opencodePluginSource: '// opencode plugin source' }),
      warn: vi.fn(),
      transientRetryDelayMs: 1,
      ...overrides
    }
    return { manager: new WslHookRelayManager(deps), deps }
  }

  it('starts one relay per distro, installs hooks, exposes the guest endpoint path, and forwards envelopes', async () => {
    const { manager, deps } = createManager({})
    manager.ensureForDistro('Ubuntu', codexHome)
    manager.ensureForDistro('Ubuntu', codexHome)
    await vi.waitFor(() => expect(deps.installHooks).toHaveBeenCalledTimes(1))
    expect(deps.spawnRelay).toHaveBeenCalledTimes(1)
    expect(deps.installCodex).toHaveBeenCalledWith(codexHome, 'Ubuntu')
    expect(deps.installHooks).toHaveBeenCalledWith(expect.anything(), home, {
      agents: []
    })

    expect(manager.getGuestEndpointFilePath('Ubuntu')).toBe(
      `${home}/.orca-wsl/agent-hooks/instance-testinstance/endpoint.env`
    )

    const guest = harnesses[0].guestDispatcher
    guest.notify(AGENT_HOOK_NOTIFICATION_METHOD, {
      paneKey: 'tab:leaf',
      payload: { state: 'working' }
    })
    await vi.waitFor(() =>
      expect(deps.ingest).toHaveBeenCalledWith(
        expect.objectContaining({ paneKey: 'tab:leaf' }),
        'wsl:Ubuntu'
      )
    )

    guest.notify(AGENT_HOOK_NOTIFICATION_METHOD, { payload: { state: 'working' } })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(deps.ingest).toHaveBeenCalledTimes(1)
    manager.disposeAll()
  })

  it('unbinds owner interrupt reconciliation when the WSL transport is retired', async () => {
    const unbind = vi.fn()
    const bind = vi.fn<NonNullable<WslHookRelayManagerDeps['bindInterruptReconciliation']>>(
      (_mux, _connectionId, _isCurrent) => unbind
    )
    const { manager } = createManager({ bindInterruptReconciliation: bind })
    manager.ensureForDistro('Ubuntu', codexHome)
    try {
      await vi.waitFor(() => expect(bind).toHaveBeenCalledOnce())
      expect(bind.mock.lastCall?.[1]).toBe('wsl:Ubuntu')
      expect(bind.mock.lastCall?.[2]()).toBe(true)
      manager.disposeAll()
      expect(unbind).toHaveBeenCalledOnce()
      expect(bind.mock.lastCall?.[2]()).toBe(false)
    } finally {
      manager.disposeAll()
    }
  })

  it('forwards Claude view requests from the guest only while hooks are enabled', async () => {
    let enabled = true
    const receive = vi.fn(() => ({ registered: true }))
    const { manager, deps } = createManager({
      receiveClaudeAgentView: receive,
      managedHookSettings: () => ({ agentStatusHooksEnabled: enabled })
    })
    await manager.ensureForDistro('Ubuntu', codexHome)
    await vi.waitFor(() => expect(deps.installHooks).toHaveBeenCalledOnce())
    const guest = harnesses[0].guestDispatcher
    harnesses[0].mux.dispose()
    const body = { action: 'register', paneKey: 'pane', sessionId: 'session' }
    expect(await guest.requestPrimary(CLAUDE_AGENT_VIEW_RELAY_METHOD, { body })).toEqual({
      registered: true
    })
    expect(receive).toHaveBeenCalledWith(body)
    enabled = false
    expect(await guest.requestPrimary(CLAUDE_AGENT_VIEW_RELAY_METHOD, { body })).toEqual({})
    expect(receive).toHaveBeenCalledOnce()
    manager.disposeAll()
  })

  it('waits for guest materialization when an explicit Pi or OMP launch needs it', async () => {
    const { manager } = createManager({})
    await expect(
      awaitExplicitAgentPluginGuestReadiness({
        isWsl: true,
        distro: 'Ubuntu',
        codexHomePath: codexHome,
        launchAgent: 'pi',
        manager
      })
    ).resolves.toBe(true)
    expect(manager.getOpenCodeOverlayDir('Ubuntu')).toBe(opencodeOverlayDir)
    manager.disposeAll()
  })

  it.each([
    { settings: {}, expected: true },
    { settings: { claudeSubagentNavigationEnabled: false }, expected: false },
    { settings: { agentStatusHooksEnabled: false }, expected: false },
    { settings: { disabledTuiAgents: ['claude' as const] }, expected: false }
  ])(
    'prepares Claude guest navigation automatically and honors opt-outs: %j',
    async ({ settings, expected }) => {
      const pluginDir = `${home}/.orca-relay/claude-agent-view/version/orca-agent-view`
      const { manager, deps } = createManager({
        pluginSources: () => ({ claudeAgentViewSource: 'export function register() {}' }),
        managedHookSettings: () => settings,
        waitForSentinel: vi.fn(async () => guestTransport({ claudePluginDir: pluginDir }))
      })
      try {
        await expect(
          awaitExplicitAgentPluginGuestReadiness({
            isWsl: true,
            distro: 'Ubuntu',
            launchAgent: 'claude',
            settings,
            manager
          })
        ).resolves.toBe(true)
        expect(manager.getClaudeAgentView('Ubuntu')).toEqual(
          expected ? { pluginDir, configDir: `${home}/.claude` } : null
        )
        if (!expected) {
          expect(deps.spawnRelay).not.toHaveBeenCalled()
        }
      } finally {
        manager.disposeAll()
      }
    }
  )

  it('does not treat the endpoint as ready before guest install completes', async () => {
    let releaseInstall!: () => void
    const installGate = new Promise<void>((resolve) => {
      releaseInstall = resolve
    })
    const { manager } = createManager({
      installHooks: vi.fn(async () => installGate.then(() => []))
    })
    const readiness = awaitExplicitAgentPluginGuestReadiness({
      isWsl: true,
      distro: 'Ubuntu',
      launchAgent: 'pi',
      timeoutMs: 50,
      manager
    })
    await vi.waitFor(() => expect(manager.getGuestEndpointFilePath('Ubuntu')).toBeNull())
    releaseInstall()
    await expect(readiness).resolves.toBe(true)
    manager.disposeAll()
  })

  it('reports relay startup failure without blocking the explicit launch forever', async () => {
    const { manager } = createManager({
      waitForSentinel: vi.fn(async () => {
        throw startupError(17, 'guest unavailable')
      })
    })
    await expect(
      awaitExplicitAgentPluginGuestReadiness({
        isWsl: true,
        distro: 'Ubuntu',
        launchAgent: 'omp',
        manager,
        timeoutMs: 50
      })
    ).resolves.toBe(false)
    manager.disposeAll()
  })

  it('times out a relay that never reaches guest materialization', async () => {
    const { manager } = createManager({
      waitForSentinel: vi.fn(() => new Promise<MultiplexerTransport>(() => {}))
    })
    await expect(
      awaitExplicitAgentPluginGuestReadiness({
        isWsl: true,
        distro: 'Ubuntu',
        launchAgent: 'pi',
        timeoutMs: 5,
        manager
      })
    ).resolves.toBe(false)
    manager.disposeAll()
  })

  it('does not wait or start a relay for a bare shell', async () => {
    const { manager } = createManager({})
    await expect(
      awaitExplicitAgentPluginGuestReadiness({
        isWsl: true,
        distro: 'Ubuntu',
        launchCommand: 'bash',
        manager
      })
    ).resolves.toBe(true)
    expect(manager.getGuestEndpointFilePath('Ubuntu')).toBeNull()
  })

  it('forwards the WSL guest Claude version to the shared remote installer', async () => {
    const waitForSentinel = vi.fn(async () =>
      guestTransport({ detectedAgents: ['claude'], claudeVersion: '2.1.261 (Claude Code)' })
    )
    const { manager, deps } = createManager({ waitForSentinel })

    manager.ensureForDistro('Ubuntu')
    await vi.waitFor(() => expect(deps.installHooks).toHaveBeenCalledTimes(1))

    expect(deps.installHooks).toHaveBeenCalledWith(expect.anything(), home, {
      agents: ['claude'],
      claudeVersion: '2.1.261'
    })
    manager.disposeAll()
  })

  it('reinstalls into a newly resolved runtime home without restarting the relay', async () => {
    const { manager, deps } = createManager({})
    manager.ensureForDistro('Ubuntu', codexHome)
    await vi.waitFor(() => expect(deps.installCodex).toHaveBeenCalledTimes(1))
    const nextHome = codexHome.replace('codex-runtime-home', 'codex-accounts\\account-2')

    manager.ensureForDistro('ubuntu', nextHome)
    await vi.waitFor(() => expect(deps.installCodex).toHaveBeenCalledTimes(2))

    expect(deps.installCodex).toHaveBeenLastCalledWith(nextHome, 'Ubuntu')
    expect(deps.spawnRelay).toHaveBeenCalledTimes(1)
    manager.disposeAll()
  })

  it('ships the OpenCode plugin to the guest and exposes the overlay dir', async () => {
    const { manager } = createManager({})
    manager.ensureForDistro('Ubuntu', codexHome)
    await vi.waitFor(() => expect(manager.getOpenCodeOverlayDir('Ubuntu')).toBe(opencodeOverlayDir))
    manager.disposeAll()
  })

  it('keeps the OpenCode 2 guest overlay separate', async () => {
    const { manager } = createManager({})
    manager.ensureForDistro('Ubuntu', codexHome)
    await vi.waitFor(() =>
      expect(manager.getOpenCodeOverlayDir('Ubuntu', 'opencode2')).toBe(opencode2OverlayDir)
    )
    expect(manager.getOpenCodeOverlayDir('Ubuntu', 'opencode')).toBe(opencodeOverlayDir)
    manager.disposeAll()
  })

  it('leaves the overlay dir null when the guest bundle lacks the installPlugins handler', async () => {
    const waitForSentinel = vi.fn(async () => guestTransport({ registerInstallPlugins: false }))
    const { manager, deps } = createManager({ waitForSentinel })
    manager.ensureForDistro('Ubuntu')
    await vi.waitFor(() => expect(deps.installHooks).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(manager.getOpenCodeOverlayDir('Ubuntu')).toBeNull()
    expect(deps.warn).not.toHaveBeenCalledWith(expect.stringContaining('installPlugins'))
    manager.disposeAll()
  })

  it('does not mutate managed agent homes when no WSL agents are detected', async () => {
    const waitForSentinel = vi.fn(async () => guestTransport({ detectedAgents: [] }))
    const { manager, deps } = createManager({ waitForSentinel })

    manager.ensureForDistro('Ubuntu')
    await vi.waitFor(() => expect(manager.getOpenCodeOverlayDir('Ubuntu')).toBe(opencodeOverlayDir))

    expect(deps.installHooks).not.toHaveBeenCalled()
    manager.disposeAll()
  })

  it('resolves the default distro for null and dedupes it with the explicit name', async () => {
    const { manager, deps } = createManager({})
    manager.ensureForDistro(null)
    await vi.waitFor(() => expect(deps.installHooks).toHaveBeenCalledTimes(1))
    manager.ensureForDistro('Ubuntu')
    manager.ensureForDistro(null)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(deps.spawnRelay).toHaveBeenCalledTimes(1)
    expect(manager.getGuestEndpointFilePath(null)).toBe(
      `${home}/.orca-wsl/agent-hooks/instance-testinstance/endpoint.env`
    )
    manager.disposeAll()
  })

  it('reinstalls once on a stale-version exit (42) and then connects', async () => {
    const waitForSentinel = vi
      .fn()
      .mockRejectedValueOnce(startupError(42))
      .mockImplementationOnce(async () => guestTransport())
    const { manager, deps } = createManager({ waitForSentinel })
    manager.ensureForDistro('Ubuntu')
    await vi.waitFor(() => expect(deps.installHooks).toHaveBeenCalledTimes(1))
    expect(deps.runInstall).toHaveBeenCalledTimes(1)
    expect(deps.spawnRelay).toHaveBeenCalledTimes(2)
    manager.disposeAll()
  })

  it('gives up without installing when the guest has no node (43)', async () => {
    const waitForSentinel = vi.fn().mockRejectedValue(startupError(43))
    const { manager, deps } = createManager({ waitForSentinel })
    manager.ensureForDistro('Ubuntu')
    await vi.waitFor(() =>
      expect(deps.warn).toHaveBeenCalledWith(expect.stringContaining('no node'))
    )
    expect(deps.runInstall).not.toHaveBeenCalled()
    manager.ensureForDistro('Ubuntu')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(deps.spawnRelay).toHaveBeenCalledTimes(1)
    manager.disposeAll()
  })

  it('retries a bounded number of times on catastrophic wsl.exe failures', async () => {
    const waitForSentinel = vi
      .fn()
      .mockRejectedValueOnce(startupError(1, 'Catastrophic failure (E_UNEXPECTED)'))
      .mockRejectedValueOnce(startupError(1, 'Catastrophic failure (E_UNEXPECTED)'))
      .mockImplementationOnce(async () => guestTransport())
    const { manager, deps } = createManager({ waitForSentinel })
    manager.ensureForDistro('Ubuntu')
    await vi.waitFor(() => expect(deps.installHooks).toHaveBeenCalledTimes(1))
    expect(deps.spawnRelay).toHaveBeenCalledTimes(3)
    expect(deps.runInstall).not.toHaveBeenCalled()
    manager.disposeAll()
  })

  it('marks the distro failed when the relay exits and blocks an immediate re-ensure', async () => {
    const children: ReturnType<typeof fakeChild>[] = []
    const spawnRelay = vi.fn(() => {
      const child = fakeChild()
      children.push(child)
      return child
    })
    const { manager, deps } = createManager({ spawnRelay })
    manager.ensureForDistro('Ubuntu')
    await vi.waitFor(() => expect(deps.installHooks).toHaveBeenCalledTimes(1))

    children[0].emitClose()
    await vi.waitFor(() =>
      expect(deps.warn).toHaveBeenCalledWith(expect.stringContaining('exited'))
    )
    manager.ensureForDistro('Ubuntu')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(spawnRelay).toHaveBeenCalledTimes(1)
    manager.disposeAll()
  })

  it('is inert off-Windows, when remote hooks are disabled, and when agent status hooks are off', async () => {
    const offPlatform = createManager({ platform: () => 'darwin' })
    offPlatform.manager.ensureForDistro('Ubuntu')
    const disabled = createManager({ remoteHooksEnabled: () => false })
    disabled.manager.ensureForDistro('Ubuntu')
    const hooksOff = createManager({
      managedHookSettings: () => ({ agentStatusHooksEnabled: false })
    })
    hooksOff.manager.ensureForDistro('Ubuntu')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(offPlatform.deps.spawnRelay).not.toHaveBeenCalled()
    expect(disabled.deps.spawnRelay).not.toHaveBeenCalled()
    expect(hooksOff.deps.spawnRelay).not.toHaveBeenCalled()
  })

  it('stops live relays and refuses to revive them once agent status hooks are switched off', async () => {
    const settings = { agentStatusHooksEnabled: true }
    const { manager, deps } = createManager({ managedHookSettings: () => settings })
    manager.ensureForDistro('Ubuntu', codexHome)
    await vi.waitFor(() => expect(deps.installHooks).toHaveBeenCalledTimes(1))

    settings.agentStatusHooksEnabled = false
    manager.disposeAll({ permanent: false })
    manager.ensureForDistro('Ubuntu')
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(deps.spawnRelay).toHaveBeenCalledTimes(1)
    expect(deps.installHooks).toHaveBeenCalledTimes(1)
    expect(manager.getGuestEndpointFilePath('Ubuntu')).toBeNull()

    settings.agentStatusHooksEnabled = true
    manager.resumeStoppedRelays()
    await vi.waitFor(() => expect(deps.spawnRelay).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(deps.installCodex).toHaveBeenCalledTimes(2))
    expect(deps.installCodex).toHaveBeenLastCalledWith(codexHome, 'Ubuntu')
    manager.disposeAll()
  })

  it('does not resume a relay whose distro the user shut down while hooks were off', async () => {
    const settings = { agentStatusHooksEnabled: true }
    const isDistroRunning = vi.fn(async () => true)
    const { manager, deps } = createManager({
      isDistroRunning,
      managedHookSettings: () => settings
    })
    manager.ensureForDistro('Ubuntu')
    await vi.waitFor(() => expect(deps.spawnRelay).toHaveBeenCalledTimes(1))

    settings.agentStatusHooksEnabled = false
    manager.disposeAll({ permanent: false })
    settings.agentStatusHooksEnabled = true
    // Recovery must not boot a distro the user shut down.
    isDistroRunning.mockResolvedValue(false)
    manager.resumeStoppedRelays()
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(deps.spawnRelay).toHaveBeenCalledTimes(1)
    isDistroRunning.mockResolvedValue(true)
    manager.resumeStoppedRelays()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(deps.spawnRelay).toHaveBeenCalledTimes(1)
  })

  it('abandons a launch that was still in flight when hooks were switched off', async () => {
    let failSentinel: ((error: unknown) => void) | undefined
    const { manager, deps } = createManager({
      waitForSentinel: vi.fn(
        () =>
          new Promise<MultiplexerTransport>((_resolve, reject) => {
            failSentinel = reject
          })
      )
    })
    manager.ensureForDistro('Ubuntu')
    await vi.waitFor(() => expect(deps.spawnRelay).toHaveBeenCalledTimes(1))

    manager.disposeAll({ permanent: false })
    // Teardown startup failures must not retry into an untracked relay after opt-out.
    failSentinel?.(startupError(1))
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(deps.spawnRelay).toHaveBeenCalledTimes(1)
    expect(deps.runInstall).not.toHaveBeenCalled()
  })

  it('requires WSL fs-bridge home coordinates before exposing an endpoint path', () => {
    const { manager } = createManager({})
    expect(manager.getGuestEndpointFilePath('Ubuntu')).toBeNull()
    expect(manager.getGuestEndpointFilePath(null)).toBeNull()
  })

  it('keeps a fresh state that replaced a failed one while its restart probe was in flight', async () => {
    // Drain microtasks under fake timers (queueMicrotask is not a faked timer).
    const flush = async (): Promise<void> => {
      for (let i = 0; i < 25; i++) {
        await Promise.resolve()
      }
    }
    let resolveProbe: ((running: boolean) => void) | undefined
    const isDistroRunning = vi.fn(() => new Promise<boolean>((resolve) => (resolveProbe = resolve)))
    const spawnRelay = vi.fn(() => fakeChild())
    // Keep the replacement before its sentinel so cleanup must preserve its starting state.
    const waitForSentinel = vi
      .fn()
      .mockRejectedValueOnce(new Error('relay died before sentinel'))
      .mockReturnValueOnce(new Promise<never>(() => {}))
    const { manager, deps } = createManager({ isDistroRunning, spawnRelay, waitForSentinel })

    vi.useFakeTimers()
    try {
      manager.ensureForDistro('Ubuntu')
      await flush()
      expect(spawnRelay).toHaveBeenCalledTimes(1)
      expect(deps.warn).toHaveBeenCalledWith(expect.stringContaining('relay died before sentinel'))

      await vi.advanceTimersByTimeAsync(FAILURE_COOLDOWN_BASE_MS + 300)
      expect(isDistroRunning).toHaveBeenCalledTimes(1)

      // A fresh ensure replaces the failed state while its restart probe is pending.
      manager.ensureForDistro('Ubuntu')
      await flush()
      expect(spawnRelay).toHaveBeenCalledTimes(2)

      // The old probe must not drop the replacement and orphan its relay.
      resolveProbe?.(false)
      await flush()
      expect(deps.warn).not.toHaveBeenCalledWith(expect.stringContaining('distro not running'))

      manager.ensureForDistro('Ubuntu')
      await flush()
      expect(spawnRelay).toHaveBeenCalledTimes(2)
    } finally {
      manager.disposeAll()
      vi.useRealTimers()
    }
  })
})
