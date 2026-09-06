// Integrator wiring (Unit 8, spec S10 step 4): owns the single active host connection — one
// OrcaSocketClient plus its four state controllers — and swaps it out on connectHost. v1 keeps
// exactly one host connected at a time (spec S6), so switching hosts always tears down the
// previous session first.
import type { CompatVerdict } from '@orca-shared/protocol-compat'
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
import { topFrame } from '../navigation/hud-navigation-frames'
import type { HudStore } from '../state/hud-store'
import type { HostProfilePort } from './profile-controller'

export type ActiveHostSession = {
  hostId: string
  client: OrcaSocketClient
  dashboard: WorktreeDashboardController
  terminalTail: TerminalTailController
  stop(): void
}

export type HostSessionManagerDeps = {
  store: HudStore
  hostProfileStore: HostProfilePort
  isForeground(): boolean
  socketFactory?: (url: string) => WebSocketLike
}

export class HostSessionManager {
  private active: ActiveHostSession | null = null
  private connectSeq = 0

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
    const seq = ++this.connectSeq

    const { store } = this.deps
    // Host-switch guard (finding #2): clear every host-scoped slice up front so a stale ask,
    // dashboard row, or terminal tail from the previous host can never resolve+send through
    // this one while the new connection/compat handshake is still in flight.
    store.update((s) => ({
      ...s,
      connection: { hostId, state: 'connecting', compat: null },
      dashboard: { rows: [], fetchedAt: 0, stale: false },
      inbox: { entries: [] },
      terminalTail: { terminalId: null, lines: [], live: false }
    }))

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
        // Finding #12: the ask screen must also count as visible — otherwise dashboard polling
        // (and therefore the confirmation-poll's `worktree.ps` refreshes) stalls while an ask is
        // open, and the ask screen can never observe its own worktree leaving `permission`.
        return screen === 'dashboard' || screen === 'worktreeList' || screen === 'ask'
      },
      isForeground: () => this.deps.isForeground(),
      now: () => Date.now()
    })
    const notifications = new NotificationInboxController(store, { port: client })
    const terminalTail = new TerminalTailController(store, {
      port: client,
      createDecoder: () => new TerminalTailDecoder()
    })

    let stopNotifications = (): void => {}
    let stopInboxNudge = (): void => {}

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

    // Bootstrap gate (finding #4): dashboard polling and the notification/terminal
    // subscriptions must not start until the compat handshake resolves. Starting them against
    // a desktop this client hasn't yet cleared as compatible is exactly the silent-mismatch
    // risk the compat gate exists to prevent — and if the verdict is `blocked`, they must never
    // start at all; the block screen already renders from ConnectionSlice.compat.
    const verdict = await this.awaitCompatVerdict(seq)
    if (this.connectSeq !== seq || verdict === null || verdict.kind === 'blocked') {
      return
    }

    dashboard.start()
    stopNotifications = notifications.start()
    // Push-nudge (spec S8): any incoming notification refreshes the dashboard immediately.
    let lastEntries = store.getState().inbox.entries
    stopInboxNudge = store.subscribe((s) => {
      if (s.inbox.entries !== lastEntries) {
        lastEntries = s.inbox.entries
        dashboard.refreshNow()
      }
    })
  }

  close(): void {
    this.connectSeq++ // invalidate any connect() still waiting on a compat verdict
    this.active?.stop()
    this.active = null
  }

  /** Resolves once ConnectionStatusController records a compat verdict for this connect() call,
   *  or null if superseded by a later connect()/close() or the socket never reaches `connected`. */
  private awaitCompatVerdict(seq: number): Promise<CompatVerdict | null> {
    const { store } = this.deps
    return new Promise((resolve) => {
      const settle = (): boolean => {
        if (this.connectSeq !== seq) {
          resolve(null)
          return true
        }
        const { connection } = store.getState()
        if (connection.compat !== null) {
          resolve(connection.compat)
          return true
        }
        if (connection.state === 'auth-failed' || connection.state === 'disconnected') {
          resolve(null)
          return true
        }
        return false
      }
      if (settle()) {
        return
      }
      const unsubscribe = store.subscribe(() => {
        if (settle()) {
          unsubscribe()
        }
      })
    })
  }
}
