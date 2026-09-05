// Integrator wiring (Unit 8, spec S10 boot sequence): seeds the store, renders once before any
// network await, wires the input router + render pipeline, and connects automatically when
// exactly one host profile is known. Test/sim callers inject `hostProfileStore`/`socketFactory`
// to point the same shell at MockGlassesBridge + MockOrcaServer instead of a real bridge/socket.
import { buildHudPage } from '../hud/hud-page-spec'
import { HudRenderQueue } from '../hud/hud-render-queue'
import type { GlassesBridge } from '../glasses/glasses-bridge'
import { HudInputRouter } from '../navigation/hud-input-router'
import { createInitialNavState } from '../navigation/hud-navigation'
import { renderScreen } from '../screens/screen-view-model'
import { createHudStore, type HudState, type HudStore } from '../state/hud-store'
import { HostProfileStore } from '../transport/host-profile-store'
import type { WebSocketLike } from '../transport/orca-socket-client'
import { buildNavContext } from './nav-context'
import { HostSessionManager } from './host-session-manager'
import { createNavPorts } from './nav-ports'

export type AppShellOptions = {
  bridge: GlassesBridge
  hostProfileStore?: HostProfileStore
  socketFactory?: (url: string) => WebSocketLike
}

export type AppShell = {
  store: HudStore
  router: HudInputRouter
  renderQueue: HudRenderQueue
  sessions: HostSessionManager
  stop(): void
}

function initialHudState(): HudState {
  return {
    connection: { hostId: null, state: 'disconnected', compat: null },
    hosts: [],
    dashboard: { rows: [], fetchedAt: 0, stale: false },
    inbox: { entries: [] },
    terminalTail: { terminalId: null, lines: [], live: false },
    device: null,
    askAnswered: null,
    // Neutral placeholder shown for the one tick before hostProfileStore.load() resolves
    // (spec trap: a network await before first paint leaves the glasses blank).
    nav: { stack: [{ screen: 'pairing' }], exitDialogArmed: false }
  }
}

export async function startAppShell(options: AppShellOptions): Promise<AppShell> {
  const { bridge } = options
  const hostProfileStore = options.hostProfileStore ?? new HostProfileStore(bridge)

  const store = createHudStore(initialHudState())
  const renderQueue = new HudRenderQueue(bridge)

  const submitRender = (state: HudState): void =>
    renderQueue.submit(buildHudPage(renderScreen(state)))
  store.subscribe(submitRender)
  // First render BEFORE any network await (spec S10 step 2).
  submitRender(store.getState())

  bridge.onDeviceStatusChanged((snapshot) => store.update((s) => ({ ...s, device: snapshot })))

  let foreground = true
  const sessions = new HostSessionManager({
    store,
    hostProfileStore,
    isForeground: () => foreground,
    socketFactory: options.socketFactory
  })

  const ports = createNavPorts({
    bridge,
    store,
    sessions,
    setForeground: (value) => {
      foreground = value
    }
  })

  const router = new HudInputRouter({ bridge, store, ports, buildContext: buildNavContext })
  router.start()

  const hosts = await hostProfileStore.load()
  store.update((s) => ({ ...s, hosts, nav: createInitialNavState(hosts) }))

  if (hosts.length === 1) {
    await sessions.connect(hosts[0]!.id)
  }

  return {
    store,
    router,
    renderQueue,
    sessions,
    stop: () => {
      router.stop()
      sessions.close()
    }
  }
}
