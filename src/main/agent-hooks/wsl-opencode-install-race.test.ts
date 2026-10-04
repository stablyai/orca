import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TuiAgent } from '../../shared/tui-agent'
import { RelayDispatcher } from '../../relay/dispatcher'
import { PluginOverlayManager } from '../../relay/plugin-overlay'
import { createInstallPluginsHandler } from '../../relay/wsl-install-plugins-handler'
import { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { AGENT_HOOK_INSTALL_PLUGINS_METHOD } from '../../shared/agent-hook-relay'
import {
  maybeRerunWslRelayGuestInstall,
  runWslRelayGuestInstall
} from './wsl-hook-relay-guest-install'
import type { WslRelayDistroState } from './wsl-hook-relay-state'
import { REINSTALL_MIN_INTERVAL_MS } from './wsl-hook-relay-deps'

function heldRequest() {
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

let root: string
let state: WslRelayDistroState
let settings: { disabledTuiAgents: TuiAgent[] }
let guests: { mux: SshChannelMultiplexer; dispatcher: RelayDispatcher }[]
const sources = { opencodePluginSource: '// v1', opencode2PluginSource: '// v2' }
const deps = {
  pluginSources: () => sources,
  managedHookSettings: () => settings,
  installHooks: vi.fn(async () => []),
  installCodex: async () => null,
  warn: vi.fn<(message: string) => void>()
}

function createGuest(name: string, beforeInstall?: (index: number) => Promise<void>) {
  const home = join(root, name)
  mkdirSync(join(home, '.config', 'opencode'), { recursive: true })
  const callbacks: ((data: Buffer) => void)[] = []
  const dispatcher = new RelayDispatcher((data) => callbacks.forEach((callback) => callback(data)))
  const mux = new SshChannelMultiplexer({
    write: (data) => dispatcher.feed(data),
    onData: (callback) => {
      callbacks.push(callback)
    },
    onClose: () => {}
  })
  const install = createInstallPluginsHandler(new PluginOverlayManager({ homeDir: home }), {
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    ORCA_WSL_HOOK_INSTANCE: name
  })
  const requests: Record<string, unknown>[] = []
  dispatcher.onRequest('preflight.detectAgents', async () => ({ agents: [] }))
  dispatcher.onRequest(AGENT_HOOK_INSTALL_PLUGINS_METHOD, async (params) => {
    requests.push(params)
    await beforeInstall?.(requests.length)
    return install(params)
  })
  const guest = { home, mux, dispatcher, requests }
  guests.push(guest)
  return guest
}

function connect(guest: ReturnType<typeof createGuest>) {
  state.mux = guest.mux
  state.guestHome = guest.home
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-wsl-install-race-'))
  guests = []
  settings = { disabledTuiAgents: [] }
  deps.installHooks.mockReset().mockResolvedValue([])
  deps.warn.mockReset()
  state = {
    distro: 'fixture',
    phase: 'running',
    launchKinds: new Set(),
    failures: 0,
    cooldownUntil: 0
  }
})
afterEach(() => {
  vi.restoreAllMocks()
  for (const guest of guests) {
    guest.mux.dispose()
    guest.dispatcher.dispose()
  }
  rmSync(root, { recursive: true, force: true })
})

it.each([true, false])('coalesces waiters through a held %s enablement toggle', async (enabled) => {
  const first = heldRequest()
  const second = heldRequest()
  const guest = createGuest('guest', (index) => (index === 1 ? first.wait() : second.wait()))
  connect(guest)
  settings.disabledTuiAgents = enabled ? [] : ['opencode', 'opencode2']
  const initial = runWslRelayGuestInstall(deps, state, guest.mux, guest.home)
  await first.reached
  settings.disabledTuiAgents = enabled ? ['opencode', 'opencode2'] : []
  let settled = 0
  const waiters = Array.from({ length: 4 }, () =>
    maybeRerunWslRelayGuestInstall(deps, state).then(() => {
      settled++
    })
  )
  first.release()
  await vi.waitFor(() => expect(guest.requests).toHaveLength(2), { timeout: 1000 })
  await second.reached
  expect(settled).toBe(0)
  expect(guest.requests).toHaveLength(2)
  second.release()
  await Promise.all([initial, ...waiters])
  expect(guest.requests).toHaveLength(2)
  expect(guest.requests[1]).toMatchObject(
    enabled ? { opencodePluginSource: '', opencode2PluginSource: '' } : sources
  )
  if (enabled) {
    expect(state.opencodeOverlayDir).toBeUndefined()
    expect(state.opencode2OverlayDir).toBeUndefined()
  } else {
    expect(
      readFileSync(join(state.opencodeOverlayDir!, 'plugins', 'orca-opencode-status.js'), 'utf8')
    ).toBe('// v1')
    expect(
      readFileSync(join(state.opencode2OverlayDir!, 'plugins', 'orca-opencode2-status.js'), 'utf8')
    ).toBe('// v2')
  }
  await maybeRerunWslRelayGuestInstall(deps, state)
  expect(guest.requests).toHaveLength(2)
  expect(state.installation).toBeUndefined()
})

it('drains reentrant toggles during successive requests without duplicate passes', async () => {
  const waiters: Promise<void>[] = []
  const guest = createGuest('guest', async (index) => {
    if (index <= 2) {
      settings.disabledTuiAgents = index === 1 ? ['opencode'] : ['opencode', 'opencode2']
      waiters.push(maybeRerunWslRelayGuestInstall(deps, state))
    }
  })
  connect(guest)
  await maybeRerunWslRelayGuestInstall(deps, state)
  await Promise.all(waiters)
  expect(
    guest.requests.map((params) => [params.opencodePluginSource, params.opencode2PluginSource])
  ).toEqual([
    ['// v1', '// v2'],
    ['', '// v2'],
    ['', '']
  ])
  expect(state.opencodeOverlayDir).toBeUndefined()
  expect(state.opencode2OverlayDir).toBeUndefined()
})

it('does not reinstall for rapid toggles that return to the in-flight settings', async () => {
  const held = heldRequest()
  const guest = createGuest('guest', () => held.wait())
  connect(guest)
  const initial = runWslRelayGuestInstall(deps, state, guest.mux, guest.home)
  await held.reached
  settings.disabledTuiAgents = ['opencode', 'opencode2']
  const disabled = maybeRerunWslRelayGuestInstall(deps, state)
  settings.disabledTuiAgents = []
  const enabled = maybeRerunWslRelayGuestInstall(deps, state)
  held.release()
  await Promise.all([initial, disabled, enabled])
  expect(guest.requests).toHaveLength(1)
  expect(state.opencodeOverlayDir).toBeTruthy()
  expect(state.opencode2OverlayDir).toBeTruthy()
})

it('coalesces an ensure re-entering before the first asynchronous hook operation', async () => {
  const guest = createGuest('guest')
  connect(guest)
  const waiters: Promise<void>[] = []
  vi.spyOn(deps, 'managedHookSettings').mockImplementationOnce(() => {
    waiters.push(maybeRerunWslRelayGuestInstall(deps, state))
    return settings
  })
  await runWslRelayGuestInstall(deps, state, guest.mux, guest.home)
  await Promise.all(waiters)
  expect(guest.requests).toHaveLength(1)
  expect(state.opencodeOverlayDir).toBeTruthy()
})

it('finishes a slow pass once, leaving time-based refresh to a later ensure', async () => {
  let now = Date.now()
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  const held = heldRequest()
  const guest = createGuest('guest', async (index) => {
    if (index === 1) {
      await held.wait()
    }
  })
  connect(guest)
  const initial = maybeRerunWslRelayGuestInstall(deps, state)
  await held.reached
  now += REINSTALL_MIN_INTERVAL_MS + 1
  held.release()
  await initial
  expect(guest.requests).toHaveLength(1)
  await maybeRerunWslRelayGuestInstall(deps, state)
  expect(guest.requests).toHaveLength(2)
})

it.each([true, false])(
  'handles a rejected joined task with changed settings %s',
  async (changed) => {
    const reached = Promise.withResolvers<void>()
    const rejected = Promise.withResolvers<void>()
    const guest = createGuest('guest')
    connect(guest)
    guest.dispatcher.onRequest('preflight.detectAgents', async () => ({ agents: ['claude'] }))
    deps.installHooks.mockImplementationOnce(async () => {
      reached.resolve()
      await rejected.promise
      return []
    })
    const initial = runWslRelayGuestInstall(deps, state, guest.mux, guest.home).catch(
      (error) => error
    )
    await reached.promise
    if (changed) {
      settings.disabledTuiAgents = ['opencode', 'opencode2']
    }
    const waiter = maybeRerunWslRelayGuestInstall(deps, state)
    rejected.reject(new Error('fixture installation failed'))
    expect(await initial).toMatchObject({ message: 'fixture installation failed' })
    await waiter
    expect(deps.warn).toHaveBeenCalledWith(expect.stringContaining('fixture installation failed'))
    expect(guest.requests).toHaveLength(changed ? 1 : 0)
    if (changed) {
      expect(guest.requests[0]).toMatchObject({
        opencodePluginSource: '',
        opencode2PluginSource: ''
      })
    }
    expect(state.installation).toBeUndefined()
    expect(state.opencodeOverlayDir).toBeUndefined()
  }
)

it('does not publish a held response or reinstall after ownership is removed', async () => {
  const held = heldRequest()
  const guest = createGuest('retired', () => held.wait())
  connect(guest)
  const initial = runWslRelayGuestInstall(deps, state, guest.mux, guest.home)
  await held.reached
  settings.disabledTuiAgents = ['opencode', 'opencode2']
  const waiter = maybeRerunWslRelayGuestInstall(deps, state)
  state.mux = undefined
  held.release()
  await Promise.all([initial, waiter])
  expect(guest.requests).toHaveLength(1)
  expect(state.opencodeOverlayDir).toBeUndefined()
  expect(state.opencode2OverlayDir).toBeUndefined()
})

it('leaves the replacement task and its paths owned by the new mux', async () => {
  const oldHeld = heldRequest()
  const nextHeld = heldRequest()
  const old = createGuest('old', () => oldHeld.wait())
  connect(old)
  const initial = runWslRelayGuestInstall(deps, state, old.mux, old.home)
  await oldHeld.reached
  const waiter = maybeRerunWslRelayGuestInstall(deps, state)
  const next = createGuest('next', () => nextHeld.wait())
  connect(next)
  state.installation = undefined
  const replacement = runWslRelayGuestInstall(deps, state, next.mux, next.home)
  await nextHeld.reached
  const ownedTask = state.installation
  oldHeld.release()
  await initial
  expect(state.installation).toBe(ownedTask)
  expect(state.opencodeOverlayDir).toBeUndefined()
  expect(state.opencode2OverlayDir).toBeUndefined()
  nextHeld.release()
  await Promise.all([waiter, replacement])
  expect(state.opencodeOverlayDir).toContain(next.home)
  expect(state.opencode2OverlayDir).toContain(next.home)
  expect(old.requests).toHaveLength(1)
  expect(next.requests).toHaveLength(1)
})

it('does not dispatch plugins after teardown during hook detection', async () => {
  const held = heldRequest()
  const guest = createGuest('retired')
  connect(guest)
  guest.dispatcher.onRequest('preflight.detectAgents', async () => {
    await held.wait()
    return { agents: [] }
  })
  const initial = runWslRelayGuestInstall(deps, state, guest.mux, guest.home)
  await held.reached
  state.mux = undefined
  held.release()
  await initial
  expect(guest.requests).toHaveLength(0)
  expect(state.opencodeOverlayDir).toBeUndefined()
})

it('does not dispatch a recheck on a disposed mux', async () => {
  const held = heldRequest()
  const guest = createGuest('disposed', () => held.wait())
  connect(guest)
  const initial = runWslRelayGuestInstall(deps, state, guest.mux, guest.home)
  await held.reached
  settings.disabledTuiAgents = ['opencode', 'opencode2']
  const waiter = maybeRerunWslRelayGuestInstall(deps, state)
  guest.mux.dispose()
  held.release()
  await Promise.all([initial, waiter])
  expect(guest.requests).toHaveLength(1)
  expect(state.opencodeOverlayDir).toBeUndefined()
})
