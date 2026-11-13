import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RelayDispatcher } from '../../../wsl-guest/dispatcher'
import { PluginOverlayManager } from '../../../wsl-guest/plugin-overlay'
import { createInstallPluginsHandler } from '../../../wsl-guest/wsl-install-plugins-handler'
import { WslHookRelayManager } from './wsl-hook-relay-manager'
import { REINSTALL_MIN_INTERVAL_MS } from './wsl-hook-relay-deps'
import type { MultiplexerTransport } from '../../ssh/protocol/ssh-multiplexer-transport-writer'
import type { TuiAgent } from '../../../shared/agent-launch/catalog/tui-agent'
import {
  AGENT_HOOK_INSTALL_PLUGINS_METHOD,
  AGENT_HOOK_REQUEST_REPLAY_METHOD
} from '../../../shared/agent-hook-listener/transport/agent-hook-relay'
import { WSL_HOOK_FS_METHODS } from '../../../shared/wsl-hook-relay-contract'

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
    ompExtensionSource: '// omp'
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
      transientRetryDelayMs: 1,
      // A bridge terminal stays open, so no relay idles out mid-test.
      bridgePtyPresence: { count: () => 1, onChange: () => () => {} },
      daemonBridgeSessions: async () => 'none' as const
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

  const cases = [
    { stage: 'plugin', initialEnabled: true, toggleBack: false },
    { stage: 'plugin', initialEnabled: false, toggleBack: false }
  ] as const

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
})
