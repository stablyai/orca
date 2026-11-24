import type { TrackedActivity } from './host-live-activity-record'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { DeviceRegistry } from '../../rpc/server/pairing/device-registry'
import { findPrincipalDevice } from '../../rpc/server/pairing/device-entry'
import type { LiveActivityRegistration } from '../../../../shared/notifications/live-activity-contract'
import { sessionTabPaneKey } from '../../../../shared/remote-runtime/session-graph/session-tab-pane-key'
import { worktreeIdentityKey } from '../../../../shared/worktree/id'
import type { PushGatewayClient } from '../push-gateway-client'
import { liveActivitySessionId } from './agent-overview-content'
import { deliverHostLiveActivity } from './host-live-activity-delivery'
import { refreshHostLiveActivityCensus } from './host-live-activity-census'

const LIFETIME_MS = 8 * 60 * 60_000

/** The executing host owns updates after the phone's connection has gone away. */
export class HostLiveActivities {
  private readonly activities = new Map<string, TrackedActivity>()
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly runtime: Pick<
      OrcaRuntimeService,
      | 'listAllMobileSessionTabsInventory'
      | 'onMobileSessionTabsChanged'
      | 'projectLocalAgentSessionTabs'
      | 'restoreStructuredAgentSessionTabs'
    >,
    private readonly registry: DeviceRegistry,
    private readonly gateway: Pick<
      PushGatewayClient,
      'sendLiveActivity' | 'registerLiveActivityOverview'
    >
  ) {}

  restore(): void {
    for (const device of this.registry.listDevices({ fresh: true })) {
      for (const saved of device.liveActivities ?? []) {
        if (
          saved.expiresAt > Date.now() &&
          saved.credentialRevision === (device.credentialRevision ?? 0)
        ) {
          void this.register(device.deviceId, saved).catch(() => undefined)
        }
      }
    }
  }

  async register(
    deviceId: string,
    input: LiveActivityRegistration
  ): Promise<{ registered: boolean }> {
    const device = this.registry
      .listDevices({ fresh: true })
      .find((entry) => entry.deviceId === deviceId)
    if (device?.scope !== 'mobile') {
      return { registered: false }
    }
    const saved = device.liveActivities?.find((entry) => entry.activityId === input.activityId)
    const expiresAt = saved?.expiresAt ?? Date.now() + LIFETIME_MS
    if (expiresAt <= Date.now()) {
      return { registered: false }
    }
    const key = JSON.stringify([deviceId, input.activityId])
    const existing = this.activities.get(key)
    if (
      !existing &&
      (this.activities.size >= 128 ||
        [...this.activities.values()].filter((entry) => entry.principal.deviceId === deviceId)
          .length >= 4)
    ) {
      return { registered: false }
    }
    if (
      existing &&
      (existing.input.overviewId !== input.overviewId || existing.input.scopeKey !== input.scopeKey)
    ) {
      return { registered: false }
    }
    const stored = {
      ...input,
      expiresAt,
      credentialRevision: device.credentialRevision ?? 0,
      sequence: saved?.sequence ?? 0
    }
    if (
      (!saved ||
        JSON.stringify(saved.bootstrap) !== JSON.stringify(input.bootstrap) ||
        saved.showNames !== input.showNames ||
        saved.credentialRevision !== stored.credentialRevision) &&
      !this.registry.setLiveActivities(deviceId, [
        ...(device.liveActivities ?? []).filter(
          (item) => item.activityId !== input.activityId && item.expiresAt > Date.now()
        ),
        stored
      ])
    ) {
      return { registered: false }
    }
    if (existing) {
      if (JSON.stringify(existing.input.bootstrap) !== JSON.stringify(input.bootstrap)) {
        existing.bootstrapReady = false
      }
      if (existing.principal.credentialRevision !== (device.credentialRevision ?? 0)) {
        existing.principal = {
          deviceId,
          credentialRevision: device.credentialRevision ?? 0,
          ...(device.token ? { deviceToken: device.token } : {})
        }
        existing.sent = undefined
        existing.sentAt = 0
      }
      if (existing.input.showNames !== input.showNames) {
        existing.sent = undefined
      }
      existing.input = input
      await this.send(key, existing)
      return { registered: existing.sentAt > 0 }
    }
    const entry: TrackedActivity = {
      input,
      principal: {
        deviceId,
        credentialRevision: device.credentialRevision ?? 0,
        ...(device.token ? { deviceToken: device.token } : {})
      },
      expiresAt,
      sentAt: 0,
      timestamp: 0,
      nextAt: Date.now(),
      dirty: false,
      frames: new Map(),
      initialized: false,
      authoritative: false,
      censusAuthoritative: false,
      censusAt: 0,
      sequence: stored.sequence,
      stop: () => {}
    }
    this.activities.set(key, entry)
    entry.stop = this.runtime.onMobileSessionTabsChanged(
      (frame) => {
        const id = worktreeIdentityKey(frame.worktree)
        const previous = entry.frames.get(id)
        if (previous && previous.publicationEpoch !== frame.publicationEpoch) {
          entry.authoritative = false
          entry.censusAuthoritative = false
        }
        entry.frames.set(id, frame)
        entry.collecting?.set(id, frame)
        if (entry.initialized) {
          entry.dirty = true
          entry.nextAt = Math.min(entry.nextAt, Date.now() + 250)
          this.schedule()
        }
      },
      deviceId,
      'mobile',
      { observation: 'caller' }
    )
    try {
      await refreshHostLiveActivityCensus(entry, this.runtime)
      entry.initialized = true
      await this.send(key, entry)
    } catch {
      this.remove(key, entry)
      return { registered: false }
    }
    this.schedule()
    return { registered: entry.sentAt > 0 }
  }

  unregister(deviceId: string, activityId: string): void {
    const key = JSON.stringify([deviceId, activityId])
    const entry = this.activities.get(key)
    if (entry) {
      this.remove(key, entry)
    } else {
      const device = this.registry.getDevice(deviceId)
      if (device) {
        this.registry.setLiveActivities(
          deviceId,
          (device.liveActivities ?? []).filter((saved) => saved.activityId !== activityId)
        )
      }
    }
  }

  resolveSession(
    deviceId: string,
    activityId: string,
    sessionId: string
  ): { worktreeId: string; paneKey: string } | null {
    const entry = this.activities.get(JSON.stringify([deviceId, activityId]))
    if (
      !entry ||
      entry.expiresAt <= Date.now() ||
      !findPrincipalDevice(this.registry.listDevices({ fresh: true }), entry.principal)
    ) {
      return null
    }
    for (const frame of entry.frames.values()) {
      for (const tab of this.runtime.projectLocalAgentSessionTabs(frame).frame.tabs) {
        const paneKey = sessionTabPaneKey(tab)
        if (paneKey && liveActivitySessionId(activityId, frame.worktree, paneKey) === sessionId) {
          return { worktreeId: frame.worktree, paneKey }
        }
      }
    }
    return null
  }

  stop(): void {
    for (const [key, entry] of this.activities) {
      this.remove(key, entry, false)
    }
  }

  private remove(key: string, entry: TrackedActivity, forget = true): void {
    if (this.activities.get(key) !== entry) {
      return
    }
    this.activities.delete(key)
    entry.stop()
    if (forget) {
      const device = this.registry.getDevice(entry.principal.deviceId)
      try {
        this.registry.setLiveActivities(
          entry.principal.deviceId,
          (device?.liveActivities ?? []).filter(
            (item) => item.activityId !== entry.input.activityId
          )
        )
      } catch {
        console.warn('[live-activities] Could not retire saved activity')
      }
    }
    if (this.activities.size === 0 && this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private schedule(): void {
    if (this.timer) {
      clearTimeout(this.timer)
    }
    this.timer = null
    const deadlines = [...this.activities.values()]
      .filter((entry) => !entry.pending)
      .map((entry) => entry.nextAt)
    if (deadlines.length === 0) {
      return
    }
    this.timer = setTimeout(
      () => {
        this.timer = null
        for (const [key, entry] of this.activities) {
          if (entry.nextAt <= Date.now()) {
            void this.send(key, entry).catch(() => {
              console.warn('[live-activities] Delivery failed; retry scheduled')
            })
          }
        }
      },
      Math.max(1, Math.min(...deadlines) - Date.now())
    )
    this.timer.unref?.()
  }

  private send(key: string, entry: TrackedActivity): Promise<void> {
    if (entry.pending) {
      entry.dirty = true
      return entry.pending
    }
    entry.dirty = false
    const run = this.deliver(key, entry)
      .catch((error: unknown) => {
        entry.dirty = false
        entry.nextAt = Date.now() + 30_000
        throw error
      })
      .finally(() => {
        entry.pending = undefined
        if (entry.dirty) {
          entry.dirty = false
          entry.nextAt = Date.now()
        }
        this.schedule()
      })
    entry.pending = run
    return run
  }

  private deliver(key: string, entry: TrackedActivity): Promise<void> {
    return deliverHostLiveActivity(entry, {
      runtime: this.runtime,
      registry: this.registry,
      gateway: this.gateway,
      isCurrent: () => this.activities.get(key) === entry,
      refreshCensus: () => refreshHostLiveActivityCensus(entry, this.runtime),
      remove: () => this.remove(key, entry)
    })
  }
}
