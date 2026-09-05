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
import { ProfileController, type HostProfilePort } from './profile-controller'

export type AppShellOptions = {
  bridge: GlassesBridge
  hostProfileStore?: HostProfilePort
  profiles?: ProfileController
  socketFactory?: (url: string) => WebSocketLike
}

export type AppShell = {
  store: HudStore
  router: HudInputRouter
  renderQueue: HudRenderQueue
  sessions: HostSessionManager
  profiles: ProfileController
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
  const profiles =
    options.profiles ??
    new ProfileController(options.hostProfileStore ?? new HostProfileStore(bridge))

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
    hostProfileStore: profiles,
    isForeground: () => foreground,
    socketFactory: options.socketFactory
  })

  const ports = createNavPorts({
    bridge,
    store,
    sessions,
    renderQueue,
    submitRender,
    setForeground: (value) => {
      foreground = value
    }
  })

  const router = new HudInputRouter({ bridge, store, ports, buildContext: buildNavContext })
  router.start()

  const hosts = await profiles.load()
  store.update((s) => ({ ...s, hosts, nav: createInitialNavState(hosts) }))

  if (hosts.length === 1) {
    await sessions.connect(hosts[0]!.id)
  }

  // Finding #6: react to pairing/removal after boot — the shell otherwise only ever saw the
  // profile list it loaded at startup. Pairing a new host while no session is active connects
  // it (mirrors the single-known-host boot path); removing the currently-active host's profile
  // tears its session down instead of leaving a stale connection with no backing profile.
  const stopProfileSync = profiles.subscribe((event) => {
    if (event.type === 'upserted') {
      store.update((s) => ({
        ...s,
        hosts: [...s.hosts.filter((h) => h.id !== event.profile.id), event.profile]
      }))
      if (!sessions.current()) {
        void sessions.connect(event.profile.id)
      }
    } else {
      store.update((s) => ({ ...s, hosts: s.hosts.filter((h) => h.id !== event.id) }))
      if (sessions.current()?.hostId === event.id) {
        sessions.close()
      }
    }
  })

  return {
    store,
    router,
    renderQueue,
    sessions,
    profiles,
    stop: () => {
      stopProfileSync()
      router.stop()
      sessions.close()
    }
  }
}
