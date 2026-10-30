import { collectLiveAgents, isActiveLiveAgent, type LiveHostRows } from './live-agent-summary'
import {
  buildDisconnectedPayload,
  buildFinalPayload,
  buildLingerPayload,
  buildLivePayload,
  type LivePayloadInput
} from './live-alert-payload'
import type { LiveAgent, LiveAlertPayload, LiveAlertsNativeAdapter } from './live-alert-types'
import {
  LiveAlertsHostPoller,
  type FetchHostRows,
  type HostPollerClient
} from './live-alerts-host-poller'
import type { LiveAlertsPreferences } from './live-alerts-preferences'
import {
  LiveAlertsSession,
  type LiveSessionStep,
  type LiveSessionView
} from './live-alerts-session'

/** Poll interval while the notification is up. */
export const LIVE_POLL_MS = 3_000
/** Poll interval while the app is open and nothing runs, so a new agent shows up promptly. */
export const IDLE_FOREGROUND_POLL_MS = 10_000
/** The JS timer and the native tick both fire every 3 s; one tick per window does the work. */
export const MIN_TICK_INTERVAL_MS = 2_500

export type LiveAlertsNativePort = Pick<LiveAlertsNativeAdapter, 'show' | 'finish' | 'cancel'>

export type LiveAlertsControllerDeps = {
  now: () => number
  fetchRows: FetchHostRows
  /** The host clients the app already holds; the controller never opens one. */
  listClients: () => readonly HostPollerClient[]
  isConnected: (hostId: string) => boolean
  hostName: (hostId: string) => string
  isForeground: () => boolean
  native: LiveAlertsNativePort
  /** Keeps relays and JS running in the background while the notification is up. */
  setKeepAlive: (active: boolean) => void
}

type ShowStep = Extract<LiveSessionStep, { kind: 'show' }>

/** Keeps one live notification in step with the agents on every connected host. */
export class LiveAlertsController {
  private readonly session = new LiveAlertsSession()
  private readonly poller: LiveAlertsHostPoller
  private preferences: LiveAlertsPreferences | null = null
  private lastTickAt: number | null = null
  private evaluating = false
  private disposed = false
  /** The payload last handed to native `show`; null after a finish or cancel. */
  private sentJson: string | null = null
  /** Notifications are off: stay quiet until no agent is active, then try again. */
  private unavailable = false
  private nativeQueue: Promise<void> = Promise.resolve()

  constructor(private readonly deps: LiveAlertsControllerDeps) {
    this.poller = new LiveAlertsHostPoller({
      fetchRows: deps.fetchRows,
      now: deps.now,
      onUpdate: () => this.evaluate()
    })
  }

  setPreferences(preferences: LiveAlertsPreferences): void {
    this.preferences = preferences
    this.evaluate()
  }

  /** Starts the reads that are due, then updates the notification. */
  tick(force = false): void {
    const now = this.deps.now()
    if (this.disposed) {
      return
    }
    if (!force && this.lastTickAt !== null && now - this.lastTickAt < MIN_TICK_INTERVAL_MS) {
      return
    }
    this.lastTickAt = now
    this.poller.poll(this.deps.listClients(), this.deps.isConnected, this.pollInterval())
    this.evaluate()
  }

  /** The user swiped the notification away or pressed Hide; the service already stopped. */
  dismissed(): void {
    this.session.dismissed()
    this.sentJson = null
    // Also clears a post that raced the swipe.
    this.enqueue(() => this.deps.native.cancel())
    this.deps.setKeepAlive(false)
  }

  dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    this.deps.setKeepAlive(false)
    this.enqueue(() => this.deps.native.cancel())
  }

  evaluate(): void {
    if (this.disposed || this.evaluating) {
      return
    }
    this.evaluating = true
    try {
      this.evaluateNow()
    } finally {
      this.evaluating = false
    }
  }

  private pollInterval(): number | null {
    if (!this.preferences?.enabled) {
      return null
    }
    if (this.session.isShowing()) {
      return LIVE_POLL_MS
    }
    // Idle in the background: nothing to show, and the next foreground tick reads at once.
    return this.deps.isForeground() ? IDLE_FOREGROUND_POLL_MS : null
  }

  private evaluateNow(): void {
    const now = this.deps.now()
    const staleHostIds = new Set<string>()
    const pendingHostIds = new Set<string>()
    const lastSuccessAt = new Map<string, number>()
    const hosts: LiveHostRows[] = []
    for (const snapshot of this.poller.snapshots()) {
      if (snapshot.freshness === 'stale') {
        staleHostIds.add(snapshot.hostId)
      } else if (snapshot.freshness === 'pending') {
        pendingHostIds.add(snapshot.hostId)
      }
      lastSuccessAt.set(snapshot.hostId, snapshot.lastSuccessAt)
      const hostName = this.deps.hostName(snapshot.hostId)
      hosts.push({ hostId: snapshot.hostId, hostName, worktrees: snapshot.worktrees })
    }
    const agents = collectLiveAgents(hosts, now)
    if (this.unavailable && !agents.some(isActiveLiveAgent)) {
      this.unavailable = false
    }
    const step = this.session.step({
      now,
      allowed: this.preferences?.enabled === true && !this.unavailable,
      agents,
      staleHostIds,
      pendingHostIds,
      lastSuccessAt
    })
    this.apply(
      step,
      agents.filter((agent) => !staleHostIds.has(agent.hostId))
    )
    this.deps.setKeepAlive(this.session.isShowing())
  }

  private apply(step: LiveSessionStep, agents: readonly LiveAgent[]): void {
    switch (step.kind) {
      case 'none':
        return
      case 'show':
        this.show(step, agents)
        return
      case 'finish':
        this.finish(this.finalPayload(step.final, step.session, agents))
        return
      case 'cancel':
        this.sentJson = null
        this.enqueue(() => this.deps.native.cancel())
    }
  }

  private show(step: ShowStep, agents: readonly LiveAgent[]): void {
    const payload = this.showPayload(step, agents)
    const json = payload ? JSON.stringify(payload) : null
    if (!payload || json === this.sentJson) {
      return
    }
    this.sentJson = json
    this.enqueue(async () => {
      const result = await this.deps.native.show(payload)
      if (result === 'unavailable') {
        // Notifications are off or blocked: end the session instead of retrying every tick.
        this.unavailable = true
        this.sentJson = null
        this.evaluate()
      }
    })
  }

  private showPayload(step: ShowStep, agents: readonly LiveAgent[]): LiveAlertPayload | null {
    const input = this.payloadInput(step.session, agents)
    switch (step.mode) {
      case 'live':
        return buildLivePayload(input)
      case 'lingering':
        return buildLingerPayload(input)
      case 'disconnected':
        return buildDisconnectedPayload(step.session.startedAt, 'working')
    }
  }

  private finalPayload(
    final: 'done' | 'disconnected',
    session: LiveSessionView,
    agents: readonly LiveAgent[]
  ): LiveAlertPayload {
    if (final === 'disconnected') {
      return buildDisconnectedPayload(session.startedAt, 'final')
    }
    return buildFinalPayload(this.payloadInput(session, agents))
  }

  private finish(payload: LiveAlertPayload): void {
    this.sentJson = null
    this.enqueue(() => this.deps.native.finish(payload))
  }

  private payloadInput(session: LiveSessionView, agents: readonly LiveAgent[]): LivePayloadInput {
    return {
      startedAt: session.startedAt,
      sessionKeys: session.sessionKeys,
      agents
    }
  }

  // Native calls run one after another, in order; a failed show is sent again on the next change.
  private enqueue(task: () => Promise<void>): void {
    this.nativeQueue = this.nativeQueue.then(task).catch(() => {
      this.sentJson = null
    })
  }
}

export type LiveAlertsControllerWiring = {
  scheduleRepeating: (run: () => void, intervalMs: number) => () => void
  subscribeAppActive: (onActive: () => void) => () => void
  subscribeNativeTick: (onTick: () => void) => () => void
  subscribeDismissed: (onDismissed: () => void) => () => void
  subscribePreferences: (onChange: (preferences: LiveAlertsPreferences) => void) => () => void
  loadPreferences: () => Promise<LiveAlertsPreferences>
}

/** Wires the controller to its clocks and events; the disposer removes the notification. */
export function startLiveAlertsController(
  controller: LiveAlertsController,
  wiring: LiveAlertsControllerWiring
): () => void {
  let preferencesChanged = false
  const stops = [
    wiring.scheduleRepeating(() => controller.tick(), LIVE_POLL_MS),
    wiring.subscribeAppActive(() => controller.tick(true)),
    // Fires while the screen is off too, when React Native's own timers stand still.
    wiring.subscribeNativeTick(() => controller.tick()),
    wiring.subscribeDismissed(() => controller.dismissed()),
    wiring.subscribePreferences((preferences) => {
      preferencesChanged = true
      controller.setPreferences(preferences)
      controller.tick(true)
    })
  ]
  void wiring.loadPreferences().then(
    (preferences) => {
      // A save that raced the first read wins.
      if (!preferencesChanged) {
        controller.setPreferences(preferences)
      }
      controller.tick(true)
    },
    () => controller.tick(true)
  )
  return () => {
    for (const stop of stops) {
      stop()
    }
    controller.dispose()
  }
}
