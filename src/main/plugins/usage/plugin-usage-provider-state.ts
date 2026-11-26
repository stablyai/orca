import { createHash } from 'node:crypto'
import type {
  PluginUsageProviderUpdate,
  PluginUsageReading
} from '../../../shared/plugins/contributions/plugin-usage-provider-contribution'
import { STALE_THRESHOLD_MS } from '../../rate-limits/service/service-types'
import type { ValidDiscoveredPlugin } from '../discovery/plugin-discovery'
import { pluginApprovedRevision } from '../workers/worker-admission/plugin-resident-worker'

type PluginReadings = { revision: string; byProvider: Map<string, PluginUsageReading> }

export class PluginUsageProviderState {
  private readonly readings = new Map<string, PluginReadings>()
  private readonly listeners = new Set<(snapshot: PluginUsageReading[]) => void>()
  private expiryTimer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly findApproved: (pluginKey: string) => ValidDiscoveredPlugin | null) {}

  update(plugin: ValidDiscoveredPlugin, update: PluginUsageProviderUpdate): boolean {
    const { pluginKey, manifest } = plugin
    const revision = pluginApprovedRevision(plugin)
    if (!this.isCurrent(pluginKey, revision)) {
      return false
    }
    const provider = manifest.contributes.usageProviders.find(({ id }) => id === update.id)
    if (!provider) {
      return false
    }
    const existing = this.readings.get(pluginKey)
    const byProvider = existing?.revision === revision ? existing.byProvider : new Map()
    if (update.windows.length === 0) {
      const removed = byProvider.delete(provider.id)
      if (byProvider.size === 0) {
        this.remove(pluginKey)
      } else if (removed) {
        this.publish()
      }
      return true
    }
    byProvider.set(provider.id, {
      pluginKey,
      pluginName: manifest.name,
      ...(manifest.manifestVersion === 2 && manifest.icon
        ? { iconRevision: createHash('sha256').update(revision).digest('hex') }
        : {}),
      providerId: provider.id,
      label: provider.label,
      windows: update.windows.map(({ windowMinutes, usedPercent, resetsAt }) => ({
        windowMinutes,
        usedPercent,
        resetsAt: resetsAt ?? null
      })),
      observedAt: Date.now()
    })
    this.readings.set(pluginKey, { revision, byProvider })
    this.publish()
    return true
  }

  snapshot(): PluginUsageReading[] {
    const now = Date.now()
    return [...this.readings].flatMap(([pluginKey, { revision, byProvider }]) =>
      this.isCurrent(pluginKey, revision)
        ? [...byProvider.values()].filter(({ observedAt }) => now - observedAt < STALE_THRESHOLD_MS)
        : []
    )
  }

  reconcile(): void {
    const now = Date.now()
    let changed = false
    for (const [pluginKey, { revision, byProvider }] of this.readings) {
      if (!this.isCurrent(pluginKey, revision)) {
        this.readings.delete(pluginKey)
        changed = true
        continue
      }
      for (const [providerId, { observedAt }] of byProvider) {
        if (now - observedAt >= STALE_THRESHOLD_MS) {
          byProvider.delete(providerId)
          changed = true
        }
      }
      if (byProvider.size === 0) {
        this.readings.delete(pluginKey)
      }
    }
    if (changed) {
      this.publish()
    } else {
      this.scheduleExpiry(this.snapshot())
    }
  }

  onChanged(listener: (snapshot: PluginUsageReading[]) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  remove(pluginKey: string): void {
    if (this.readings.delete(pluginKey)) {
      this.publish()
    }
  }

  dispose(): void {
    clearTimeout(this.expiryTimer)
    this.readings.clear()
    this.listeners.clear()
  }

  private isCurrent(pluginKey: string, revision: string): boolean {
    const plugin = this.findApproved(pluginKey)
    return plugin !== null && pluginApprovedRevision(plugin) === revision
  }

  private scheduleExpiry(snapshot: PluginUsageReading[]): void {
    clearTimeout(this.expiryTimer)
    this.expiryTimer = undefined
    if (snapshot.length > 0) {
      const oldest = snapshot.reduce((at, reading) => Math.min(at, reading.observedAt), Infinity)
      this.expiryTimer = setTimeout(
        () => this.reconcile(),
        oldest + STALE_THRESHOLD_MS - Date.now()
      )
      this.expiryTimer.unref()
    }
  }

  private publish(): void {
    const snapshot = this.snapshot()
    this.scheduleExpiry(snapshot)
    for (const listener of this.listeners) {
      listener(snapshot)
    }
  }
}
