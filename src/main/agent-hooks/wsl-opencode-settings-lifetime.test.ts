import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RelayDispatcher } from '../../relay/dispatcher'
import { PluginOverlayManager } from '../../relay/plugin-overlay'
import { createInstallPluginsHandler } from '../../relay/wsl-install-plugins-handler'
import { WslHookRelayManager } from './wsl-hook-relay-manager'
import { REINSTALL_MIN_INTERVAL_MS } from './wsl-hook-relay-deps'
import type { MultiplexerTransport } from '../ssh/ssh-channel-multiplexer'
import type { TuiAgent } from '../../shared/tui-agent'
import {
  AGENT_HOOK_INSTALL_PLUGINS_METHOD,
  AGENT_HOOK_REQUEST_REPLAY_METHOD
} from '../../shared/agent-hook-relay'
import { WSL_HOOK_FS_METHODS } from '../../shared/wsl-hook-relay-contract'

function gate() {
  const reached = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  return {
    reached: reached.promise,
    release: release.resolve,
    wait: async () => {
      reached.resolve()
      await release.promise
    }
  }
}

function fakeChild(): ChildProcessWithoutNullStreams {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: { write: () => true, end: () => {}, on: () => {} },
    kill: () => true
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The injected launcher and link only use these emitter, stream, and kill members; no process is spawned.
  return child as unknown as ChildProcessWithoutNullStreams
}

// Guest materialization uses POSIX home semantics; native Windows needs the WSL rig.
describe.skipIf(process.platform === 'win32')('WSL public-manager settings lifetime', () => {
  let root: string
  let manager: WslHookRelayManager
  let guests: ReturnType<typeof createGuest>[]
  let activeGuest: ReturnType<typeof createGuest>
  let settings: { disabledTuiAgents: TuiAgent[] }
  let requests: Record<string, unknown>[]
  let now: number
  let detectionCount: number
  let hookCount: number
  let pause: 'detect' | 'hooks' | 'plugin'
  let rejectRequest: boolean
  let rejectHooks: boolean
  let onPluginRequest: ((index: number) => Promise<void>) | undefined
  let beforeSources: ReturnType<typeof gate>
  let pendingRequest: ReturnType<typeof gate>
  const sources = {
    opencodePluginSource: '// independent v1',
    opencode2PluginSource: '// independent v2',
    piExtensionSource: '// pi',
    ompExtensionSource: '// omp',
    omoExtensionSource: '// omo'
  }

  function createGuest(name: string): {
    home: string
    transport: MultiplexerTransport
    dispatcher: RelayDispatcher
  } {
    const home = join(root, name)
    mkdirSync(join(home, '.config', 'opencode'), { recursive: true })
    writeFileSync(join(home, '.config', 'opencode', 'opencode.json'), '{"model":"fixture"}')
    const callbacks: ((data: Buffer) => void)[] = []
    const transport: MultiplexerTransport = {
      write: (data) => dispatcher.feed(data),
      onData: (callback) => {
        callbacks.push(callback)
      },
      onClose: () => {}
    }
    const dispatcher = new RelayDispatcher((data) =>
      callbacks.forEach((callback) => callback(data))
    )
    dispatcher.onRequest(WSL_HOOK_FS_METHODS.home, async () => ({ ok: true, home }))
    dispatcher.onRequest(AGENT_HOOK_REQUEST_REPLAY_METHOD, async () => ({ replayed: 0 }))
    dispatcher.onRequest('preflight.detectAgents', async () => {
      if (++detectionCount === 2 && pause === 'detect') {
        await beforeSources.wait()
      }
      return { agents: ['claude'] }
    })
    const install = createInstallPluginsHandler(new PluginOverlayManager({ homeDir: home }), {
      HOME: home,
      XDG_CONFIG_HOME: join(home, '.config'),
      ORCA_WSL_HOOK_INSTANCE: 'independent-manager'
    })
    dispatcher.onRequest(AGENT_HOOK_INSTALL_PLUGINS_METHOD, async (params) => {
      requests.push(params)
      if (onPluginRequest) {
        await onPluginRequest(requests.length)
      } else if (requests.length === 2) {
        await pendingRequest.wait()
        if (rejectRequest) {
          throw new Error('fixture plugin request rejected')
        }
      }
      return install(params)
    })
    const guest = { home, transport, dispatcher }
    guests.push(guest)
    return guest
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-wsl-manager-boundary-'))
    settings = { disabledTuiAgents: [] }
    requests = []
    now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    rejectRequest = false
    rejectHooks = false
    onPluginRequest = undefined
    detectionCount = 0
    hookCount = 0
    beforeSources = gate()
    pendingRequest = gate()
    guests = []
    activeGuest = createGuest('first')
    manager = new WslHookRelayManager({
      platform: () => 'win32',
      remoteHooksEnabled: () => true,
      hookCoordsEnv: () => ({ ORCA_AGENT_HOOK_PORT: '43117', ORCA_AGENT_HOOK_TOKEN: 'fixture' }),
      instanceKey: () => 'independent',
      resolveBundle: () => ({ jsPath: join(root, 'relay.js'), version: 'fixture' }),
      readBundle: () => Buffer.from('// fixture'),
      listDistros: async () => ['fixture'],
      isDistroRunning: async () => true,
      spawnRelay: () => fakeChild(),
      runInstall: async () => ({ code: 0, stderr: '' }),
      waitForSentinel: async () => activeGuest.transport,
      ingest: () => {},
      installHooks: async () => {
        if (++hookCount === 2 && pause === 'hooks') {
          await beforeSources.wait()
        }
        if (rejectHooks) {
          throw new Error('fixture hook failure')
        }
        return []
      },
      installCodex: async () => null,
      managedHookSettings: () => settings,
      pluginSources: () => sources,
      warn: vi.fn(),
      transientRetryDelayMs: 1
    })
  })
  afterEach(() => {
    manager.disposeAll()
    for (const guest of guests) {
      guest.dispatcher.dispose()
    }
    vi.restoreAllMocks()
    rmSync(root, { recursive: true, force: true })
  })

  const cases = (['detect', 'hooks', 'plugin'] as const).flatMap((stage) =>
    [true, false].flatMap((initialEnabled) =>
      [true, false].map((toggleBack) => ({ stage, initialEnabled, toggleBack }))
    )
  )

  it.each(cases)(
    'manager settings across $stage: initially enabled $initialEnabled, toggle back $toggleBack',
    async ({ stage, initialEnabled, toggleBack }) => {
      pause = stage
      const setEnabled = (enabled: boolean) => {
        settings = { disabledTuiAgents: enabled ? [] : ['opencode', 'opencode2'] }
      }
      setEnabled(initialEnabled)
      await manager.ensureForDistro('fixture')
      expect(requests).toHaveLength(1)
      now += REINSTALL_MIN_INTERVAL_MS + 1
      const refresh = manager.ensureForDistro('fixture')
      const waiters: Promise<void>[] = [refresh]
      if (stage !== 'plugin') {
        await beforeSources.reached
        setEnabled(!initialEnabled)
        waiters.push(manager.ensureForDistro('fixture'))
        beforeSources.release()
      }
      await pendingRequest.reached
      const sentEnabled = stage === 'plugin' ? initialEnabled : !initialEnabled
      expect(requests[1]).toMatchObject(
        sentEnabled
          ? sources
          : {
              opencodePluginSource: '',
              opencode2PluginSource: ''
            }
      )
      if (stage === 'plugin') {
        setEnabled(!initialEnabled)
        waiters.push(manager.ensureForDistro('fixture'))
      }
      const finalEnabled = toggleBack ? initialEnabled : !initialEnabled
      setEnabled(finalEnabled)
      waiters.push(...Array.from({ length: 4 }, () => manager.ensureForDistro('fixture')))
      pendingRequest.release()
      await Promise.all(waiters)
      expect(requests).toHaveLength(sentEnabled === finalEnabled ? 2 : 3)
      expect(requests.at(-1)).toMatchObject(
        finalEnabled
          ? sources
          : {
              opencodePluginSource: '',
              opencode2PluginSource: ''
            }
      )
      for (const agent of ['opencode', 'opencode2'] as const) {
        const dir = manager.getOpenCodeOverlayDir('fixture', agent)
        if (finalEnabled) {
          expect(dir).toBeTruthy()
          if (!dir) {
            throw new Error('missing enabled overlay')
          }
          expect(readFileSync(join(dir, 'plugins', `orca-${agent}-status.js`), 'utf8')).toBe(
            agent === 'opencode' ? sources.opencodePluginSource : sources.opencode2PluginSource
          )
        } else {
          expect(dir).toBeNull()
        }
      }
      const settledCount = requests.length
      await manager.ensureForDistro('fixture')
      expect(requests).toHaveLength(settledCount)
    }
  )

  it('preserves known pointers after plugin rejection without treating it as revocation', async () => {
    pause = 'detect'
    await manager.ensureForDistro('fixture')
    const oldV1 = manager.getOpenCodeOverlayDir('fixture')
    const oldV2 = manager.getOpenCodeOverlayDir('fixture', 'opencode2')
    now += REINSTALL_MIN_INTERVAL_MS + 1
    const refresh = manager.ensureForDistro('fixture')
    await beforeSources.reached
    settings = { disabledTuiAgents: ['opencode', 'opencode2'] }
    const disabled = manager.ensureForDistro('fixture')
    beforeSources.release()
    await pendingRequest.reached
    rejectRequest = true
    settings = { disabledTuiAgents: [] }
    const restored = manager.ensureForDistro('fixture')
    pendingRequest.release()
    await Promise.all([refresh, disabled, restored])
    expect(requests).toHaveLength(2)
    expect(manager.getOpenCodeOverlayDir('fixture')).toBe(oldV1)
    expect(manager.getOpenCodeOverlayDir('fixture', 'opencode2')).toBe(oldV2)
    await manager.ensureForDistro('fixture')
    expect(requests).toHaveLength(2)
  })

  it('tracks the settings sent by successive Pi and OMP requests', async () => {
    pause = 'plugin'
    await manager.ensureForDistro('fixture', undefined, 'pi')
    const secondKind = gate()
    onPluginRequest = async (index) => {
      if (index === 2) {
        await pendingRequest.wait()
      }
      if (index === 3) {
        await secondKind.wait()
      }
    }
    const refresh = manager.ensureForDistro('fixture', undefined, 'omp')
    await pendingRequest.reached
    settings.disabledTuiAgents = ['opencode', 'opencode2']
    const disabled = manager.ensureForDistro('fixture')
    pendingRequest.release()
    await secondKind.reached
    expect(requests[2]).toMatchObject({
      launchKind: 'omp',
      opencodePluginSource: '',
      opencode2PluginSource: ''
    })
    settings.disabledTuiAgents = []
    const restored = manager.ensureForDistro('fixture')
    secondKind.release()
    await Promise.all([refresh, disabled, restored])
    expect(requests.map((request) => request.launchKind)).toEqual(['pi', 'pi', 'omp', 'pi', 'omp'])
    expect(requests.at(-1)).toMatchObject(sources)
    expect(manager.getOpenCodeOverlayDir('fixture')).toBeTruthy()
    expect(manager.getOpenCodeOverlayDir('fixture', 'opencode2')).toBeTruthy()
    const pi = manager.getGuestAgentPath('fixture', 'pi')
    const omp = manager.getGuestAgentPath('fixture', 'omp')
    if (!pi || !omp) {
      throw new Error('missing guest agent paths')
    }
    expect(readFileSync(join(pi, 'extensions', 'orca-agent-status.ts'), 'utf8')).toContain('// pi')
    expect(readFileSync(omp, 'utf8')).toContain('// omp')
    await manager.ensureForDistro('fixture')
    expect(requests).toHaveLength(5)
  })

  it('ships and installs the OmO extension for an OmO launch kind', async () => {
    await manager.ensureForDistro('fixture', undefined, 'omo')
    expect(requests.at(-1)).toMatchObject({ launchKind: 'omo', omoExtensionSource: '// omo' })
    const omo = manager.getGuestAgentPath('fixture', 'omo')
    if (!omo) {
      throw new Error('missing guest omo agent dir')
    }
    expect(readFileSync(join(omo, 'extensions', 'orca-agent-status.ts'), 'utf8')).toContain(
      '// omo'
    )
    // Why: materializing OmO must not create another kind's dir; bare shells and
    // single-agent launches each own only the kind they asked for.
    expect(manager.getGuestAgentPath('fixture', 'pi')).toBeNull()
    expect(manager.getGuestAgentPath('fixture', 'omp')).toBeNull()
  })

  it('bounds repeated pre-plugin failures and retries after the cooldown', async () => {
    pause = 'hooks'
    await manager.ensureForDistro('fixture')
    const previous = manager.getOpenCodeOverlayDir('fixture')
    now += REINSTALL_MIN_INTERVAL_MS + 1
    const refresh = manager.ensureForDistro('fixture')
    await beforeSources.reached
    settings.disabledTuiAgents = ['opencode', 'opencode2']
    rejectHooks = true
    const waiters = Array.from({ length: 4 }, () => manager.ensureForDistro('fixture'))
    beforeSources.release()
    await Promise.all([refresh, ...waiters])
    expect(hookCount).toBe(3)
    expect(requests).toHaveLength(1)
    expect(manager.getOpenCodeOverlayDir('fixture')).toBe(previous)
    await manager.ensureForDistro('fixture')
    expect(hookCount).toBe(3)
    now += REINSTALL_MIN_INTERVAL_MS + 1
    rejectHooks = false
    pendingRequest.release()
    await manager.ensureForDistro('fixture')
    expect(hookCount).toBe(4)
    expect(requests.at(-1)).toMatchObject({ opencodePluginSource: '', opencode2PluginSource: '' })
    expect(manager.getOpenCodeOverlayDir('fixture')).toBeNull()
  })

  it('keeps a disposed generation from publishing into a reconnected manager', async () => {
    pause = 'plugin'
    await manager.ensureForDistro('fixture')
    now += REINSTALL_MIN_INTERVAL_MS + 1
    const refresh = manager.ensureForDistro('fixture')
    await pendingRequest.reached
    const waiters = Array.from({ length: 4 }, () => manager.ensureForDistro('fixture'))
    manager.disposeAll({ permanent: false })
    activeGuest = createGuest('replacement')
    await manager.ensureForDistro('fixture')
    const current = manager.getOpenCodeOverlayDir('fixture')
    expect(current).toContain(activeGuest.home)
    pendingRequest.release()
    await Promise.all([refresh, ...waiters])
    expect(requests).toHaveLength(3)
    expect(manager.getOpenCodeOverlayDir('fixture')).toBe(current)
    expect(manager.getOpenCodeOverlayDir('fixture', 'opencode2')).toContain(activeGuest.home)
  })
})
