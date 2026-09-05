// Integrator wiring (Unit 8, spec S10 step 4): owns the single active host connection — one
// OrcaSocketClient plus its four state controllers — and swaps it out on connectHost. v1 keeps
// exactly one host connected at a time (spec S6), so switching hosts always tears down the
// previous session first.
import {
  ConnectionStatusController,
  createConnectionStatusInputs
} from '../state/connection-status-state'
import { NotificationInboxController } from '../state/notification-inbox-state'
import { TerminalTailController } from '../state/terminal-tail-state'
import { WorktreeDashboardController } from '../state/worktree-dashboard-state'
import { OrcaSocketClient, type WebSocketLike } from '../transport/orca-socket-client'
import type { ConnectionState } from '../transport/orca-rpc-wire'
import { TerminalTailDecoder } from '../transport/terminal-tail-decoder'
import type { HostProfileStore } from '../transport/host-profile-store'
import { topFrame } from '../navigation/hud-navigation-frames'
import type { HudStore } from '../state/hud-store'

export type ActiveHostSession = {
  hostId: string
  client: OrcaSocketClient
  dashboard: WorktreeDashboardController
  terminalTail: TerminalTailController
  stop(): void
}

export type HostSessionManagerDeps = {
  store: HudStore
  hostProfileStore: HostProfileStore
  isForeground(): boolean
  socketFactory?: (url: string) => WebSocketLike
}

export class HostSessionManager {
  private active: ActiveHostSession | null = null

  constructor(private readonly deps: HostSessionManagerDeps) {}

  current(): ActiveHostSession | null {
    return this.active
  }

  async connect(hostId: string): Promise<void> {
    const profiles = await this.deps.hostProfileStore.load()
    const profile = profiles.find((p) => p.id === hostId)
    if (!profile) {
      return
    }
    this.close()

    const { store } = this.deps
    store.update((s) => ({ ...s, connection: { hostId, state: 'connecting', compat: null } }))

    // OrcaSocketClient only accepts one onState sink at construction time; fan it out to a
    // listener set so ConnectionStatusController can subscribe/unsubscribe like every other
    // RpcPort-shaped consumer (spec S6's RpcPort narrowing, Unit 4's contract).
    const stateListeners = new Set<(state: ConnectionState) => void>()
    const client = new OrcaSocketClient({
      endpoint: profile.endpoint,
      deviceToken: profile.deviceToken,
      serverPublicKeyB64: profile.publicKeyB64,
      socketFactory: this.deps.socketFactory,
      onState: (state) => {
        for (const listener of stateListeners) {
          listener(state)
        }
      }
    })

    const connectionController = new ConnectionStatusController(
      store,
      createConnectionStatusInputs(client, (cb) => {
        stateListeners.add(cb)
        return () => stateListeners.delete(cb)
      })
    )
    const stopConnection = connectionController.start(hostId)

    const dashboard = new WorktreeDashboardController(store, {
      port: client,
      isVisible: () => {
        const screen = topFrame(store.getState().nav).screen
        return screen === 'dashboard' || screen === 'worktreeList'
      },
      isForeground: () => this.deps.isForeground(),
      now: () => Date.now()
    })
    dashboard.start()

    const notifications = new NotificationInboxController(store, { port: client })
    const stopNotifications = notifications.start()

    // Push-nudge (spec S8): any incoming notification refreshes the dashboard immediately.
    let lastEntries = store.getState().inbox.entries
    const stopInboxNudge = store.subscribe((s) => {
      if (s.inbox.entries !== lastEntries) {
        lastEntries = s.inbox.entries
        dashboard.refreshNow()
      }
    })

    const terminalTail = new TerminalTailController(store, {
      port: client,
      createDecoder: () => new TerminalTailDecoder()
    })

    this.active = {
      hostId,
      client,
      dashboard,
      terminalTail,
      stop: () => {
        stopConnection()
        stopNotifications()
        stopInboxNudge()
        dashboard.stop()
        terminalTail.close()
        client.close()
      }
    }
  }

  close(): void {
    this.active?.stop()
    this.active = null
  }
}
