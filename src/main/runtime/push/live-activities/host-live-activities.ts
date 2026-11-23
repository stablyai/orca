import type { TrackedActivity } from './host-live-activity-record'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { DeviceRegistry } from '../../rpc/server/pairing/device-registry'
import { findPrincipalDevice } from '../../rpc/server/pairing/device-entry'
import type { LiveActivityRegistration } from '../../../../shared/notifications/live-activity-contract'
import { sessionTabPaneKey } from '../../../../shared/remote-runtime/session-graph/session-tab-pane-key'
import { worktreeIdsEqual } from '../../../../shared/worktree/id'
import type { PushGatewayClient } from '../push-gateway-client'
import { sessionLiveActivityContent } from './session-live-activity-content'

const LIFETIME_MS = 8 * 60 * 60_000
const HEARTBEAT_MS = 5 * 60_000

/** The executing host owns updates after the phone's connection has gone away. */
export class HostLiveActivities {
  private readonly activities = new Map<string, TrackedActivity>()
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly runtime: Pick<
      OrcaRuntimeService,
      'listMobileSessionTabs' | 'onMobileSessionTabsChanged'
    >,
    private readonly registry: DeviceRegistry,
    private readonly gateway: Pick<PushGatewayClient, 'sendLiveActivity'>
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
      (existing.input.worktreeId !== input.worktreeId || existing.input.paneKey !== input.paneKey)
    ) {
      return { registered: false }
    }
    const stored = { ...input, expiresAt, credentialRevision: device.credentialRevision ?? 0 }
    if (
      (!saved ||
        saved.token !== input.token ||
        saved.showNames !== input.showNames ||
        saved.apnsEnvironment !== input.apnsEnvironment ||
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
      if (existing.principal.credentialRevision !== (device.credentialRevision ?? 0)) {
        existing.principal = {
          deviceId,
          credentialRevision: device.credentialRevision ?? 0,
          ...(device.token ? { deviceToken: device.token } : {})
        }
        existing.sent = undefined
        existing.sentAt = 0
      }
      if (existing.input.token !== input.token || existing.input.showNames !== input.showNames) {
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
      sawPane: false,
      stop: () => {}
    }
    this.activities.set(key, entry)
    entry.stop = this.runtime.onMobileSessionTabsChanged(
      (frame) => {
        if (worktreeIdsEqual(frame.worktree, input.worktreeId)) {
          entry.frame = frame
          void this.send(key, entry)
        }
      },
      deviceId,
      'mobile',
      { observation: 'caller', acceptsWorktree: (id) => worktreeIdsEqual(id, input.worktreeId) }
    )
    try {
      const initial = await this.runtime.listMobileSessionTabs(`id:${input.worktreeId}`, deviceId, {
        includeAgentSenders: false
      })
      if (
        !entry.frame ||
        (entry.frame.publicationEpoch === initial.publicationEpoch &&
          entry.frame.snapshotVersion <= initial.snapshotVersion)
      ) {
        entry.frame = initial
      }
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
    }
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
            void this.send(key, entry)
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
    const run = this.deliver(key, entry).finally(() => {
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

  private async deliver(key: string, entry: TrackedActivity): Promise<void> {
    if (this.activities.get(key) !== entry) {
      return
    }
    const now = Date.now()
    const tab = entry.frame?.tabs.find(
      (candidate) => sessionTabPaneKey(candidate) === entry.input.paneKey
    )
    const lostPane = !tab && entry.sawPane
    if (tab) {
      entry.sawPane = true
    }
    const content = sessionLiveActivityContent(tab, entry.input.showNames, entry.content, now)
    if (now >= entry.expiresAt) {
      content.state = 'unavailable'
    }
    entry.content = content
    const identity = JSON.stringify([content.state, content.title, content.stateStartedAt])
    if (entry.sent === identity && now - entry.sentAt < HEARTBEAT_MS) {
      entry.nextAt = Math.min(entry.sentAt + HEARTBEAT_MS, entry.expiresAt)
      return
    }
    const timestamp = Math.floor(now / 1000)
    // APNs uses whole seconds for ordering; never race two different states with the same stamp.
    if (timestamp <= entry.timestamp) {
      entry.nextAt = (entry.timestamp + 1) * 1000
      return
    }
    if (
      findPrincipalDevice(this.registry.listDevices({ fresh: true }), entry.principal)?.scope !==
      'mobile'
    ) {
      this.remove(key, entry)
      return
    }
    const turnEnded =
      tab?.type === 'terminal'
        ? tab.agentStatus?.state === 'done'
        : tab?.type === 'agent-session' && tab.chatStatus?.state === 'done'
    const event =
      content.state === 'done' ||
      content.state === 'failed' ||
      turnEnded ||
      lostPane ||
      now >= entry.expiresAt
        ? 'end'
        : 'update'
    entry.timestamp = timestamp
    const token = entry.input.token
    entry.nextAt = now + 30_000
    try {
      const outcome = await this.gateway.sendLiveActivity({
        token: entry.input.token,
        apnsEnvironment: entry.input.apnsEnvironment,
        timestamp,
        event,
        content
      })
      if (token !== entry.input.token) {
        entry.nextAt = Date.now()
        return
      }
      if (outcome === 'sent') {
        entry.sentAt = now
      }
      if (outcome === 'dead' || (outcome === 'sent' && event === 'end')) {
        this.remove(key, entry)
      } else if (outcome === 'sent') {
        entry.sent = identity
        entry.nextAt = Math.min(now + HEARTBEAT_MS, entry.expiresAt)
      }
    } catch {
      entry.nextAt = now + 30_000
    }
  }
}
