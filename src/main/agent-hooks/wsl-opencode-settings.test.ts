import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TuiAgent } from '../../shared/tui-agent'
import { RelayDispatcher } from '../../relay/dispatcher'
import { PluginOverlayManager } from '../../relay/plugin-overlay'
import { createInstallPluginsHandler } from '../../relay/wsl-install-plugins-handler'
import { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { AGENT_HOOK_INSTALL_PLUGINS_METHOD } from '../../shared/agent-hook-relay'
import { requestGuestOpenCodeOverlayDir } from './wsl-guest-plugin-install'
import {
  maybeRerunWslRelayGuestInstall,
  runWslRelayGuestInstall
} from './wsl-hook-relay-guest-install'
import type { WslRelayDistroState } from './wsl-hook-relay-state'

let home: string
let dispatcher: RelayDispatcher
let mux: SshChannelMultiplexer
let state: WslRelayDistroState
let settings: { disabledTuiAgents: TuiAgent[] }
let params: Record<string, unknown>[]
const sources = {
  opencodePluginSource: '// v1',
  opencode2PluginSource: '// v2',
  piExtensionSource: '// pi'
}
const deps = {
  pluginSources: () => sources,
  managedHookSettings: () => settings,
  installHooks: async () => [],
  installCodex: async () => null,
  warn: (message: string) => {
    throw new Error(message)
  }
}
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orca-wsl-opencode-settings-'))
  const xdg = join(home, 'xdg')
  mkdirSync(join(xdg, 'opencode'), { recursive: true })
  writeFileSync(join(xdg, 'opencode', 'opencode.json'), '{"model":"guest-fixture"}')
  settings = { disabledTuiAgents: [] }
  params = []
  const callbacks: ((data: Buffer) => void)[] = []
  dispatcher = new RelayDispatcher((data) => {
    for (const callback of callbacks) {
      callback(data)
    }
  })
  mux = new SshChannelMultiplexer({
    write: (data) => {
      dispatcher.feed(data)
    },
    onData: (callback) => {
      callbacks.push(callback)
    },
    onClose: () => {}
  })
  const install = createInstallPluginsHandler(new PluginOverlayManager({ homeDir: home }), {
    HOME: home,
    XDG_CONFIG_HOME: xdg,
    ORCA_WSL_HOOK_INSTANCE: 'settings-fixture'
  })
  dispatcher.onRequest('preflight.detectAgents', async () => ({ agents: [] }))
  dispatcher.onRequest(AGENT_HOOK_INSTALL_PLUGINS_METHOD, async (request) => {
    params.push(request)
    return install(request)
  })
  state = {
    distro: 'fixture',
    phase: 'running',
    mux,
    guestHome: home,
    launchKinds: new Set(),
    failures: 0,
    cooldownUntil: 0
  }
})
afterEach(() => {
  mux.dispose()
  dispatcher.dispose()
  rmSync(home, { recursive: true, force: true })
})

describe('WSL settings over the existing plugin RPC into real fixture overlays', () => {
  const cases: TuiAgent[][] = [[], ['opencode'], ['opencode2'], ['opencode', 'opencode2']]
  it.each(cases.map((disabled) => ({ disabled })))(
    'honors disabled $disabled',
    async ({ disabled }) => {
      settings.disabledTuiAgents = disabled
      const result = await requestGuestOpenCodeOverlayDir(mux, deps, 'fixture')
      for (const agent of ['opencode', 'opencode2'] as const) {
        const key = agent === 'opencode' ? 'opencodePluginSource' : 'opencode2PluginSource'
        expect(params[0][key]).toBe(disabled.includes(agent) ? '' : sources[key])
      }
      if (result.kind === 'dir') {
        expect(Boolean(result.dir)).toBe(!disabled.includes('opencode'))
        expect(Boolean(result.dir2)).toBe(!disabled.includes('opencode2'))
        const dir = result.dir ?? result.dir2
        if (!dir) {
          throw new Error('missing overlay')
        }
        expect(readFileSync(join(dir, 'opencode.json'), 'utf8')).toBe('{"model":"guest-fixture"}')
      } else {
        expect(disabled).toEqual(['opencode', 'opencode2'])
      }
      expect(params[0].piExtensionSource).toBe('// pi')
    }
  )

  it('revokes cached sources before the reinstall interval and re-enables the same service', async () => {
    await runWslRelayGuestInstall(deps, state, mux, home)
    const dir = state.opencodeOverlayDir
    if (!dir) {
      throw new Error('missing original overlay')
    }
    const path = join(dir, 'plugins', 'orca-opencode-status.js')
    writeFileSync(path, '// installed sentinel')
    settings.disabledTuiAgents = ['opencode']
    await maybeRerunWslRelayGuestInstall(deps, state)
    expect(state.opencodeOverlayDir).toBeUndefined()
    expect(state.opencode2OverlayDir).toBeTruthy()
    expect(readFileSync(path, 'utf8')).toBe('// installed sentinel')
    const omitted = await requestGuestOpenCodeOverlayDir(
      mux,
      { ...deps, pluginSources: () => ({}) },
      'fixture'
    )
    expect(omitted.kind === 'dir' ? omitted.dir : undefined).toBeUndefined()
    settings.disabledTuiAgents = []
    await maybeRerunWslRelayGuestInstall(deps, state)
    expect(state.opencodeOverlayDir).toBe(dir)
    expect(existsSync(path)).toBe(true)
  })
})
