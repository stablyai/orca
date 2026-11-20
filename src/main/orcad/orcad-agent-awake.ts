// orcad-side keep-awake aggregation: the desktop's AgentAwakeService owns the
// OS blocker in its own process, but orcad is a pure Node host — it computes
// the same {mode, active} verdict from the shared status store and settings,
// then serves it over RPC so a client that can hold the OS blocker (the Tauri
// shell) applies it.

import {
  normalizeComputerAwakeMode,
  type ComputerAwakeStatus
} from '../../shared/app-lifecycle/computer-awake-mode'
import { AgentAwakeStatusLease, type AgentAwakeStatus } from '../power/agent-awake-status-lease'
import type { AgentHookServer } from '../agent-hooks/server/agent-hook-server'
import type { ProfilePreferences } from '../persistence/loading-store/profile-preferences/profile-preferences'

export type AgentAwakeStatusListener = (status: ComputerAwakeStatus) => void

/**
 * Host-side `powerSaveBlocker` policy without the blocker. Mirrors
 * `AgentAwakeService`'s decision surface: mode comes from host settings, the
 * lease drops rows whose evidence is stale, and `active` resolves `on` or
 * `auto`-with-working-agents.
 */
export class OrcadAgentAwakeService {
  private readonly lease: AgentAwakeStatusLease
  private readonly listeners = new Set<AgentAwakeStatusListener>()
  private lastPublished: ComputerAwakeStatus | null = null
  private readonly unsubscribers: (() => void)[] = []

  constructor(
    private readonly store: Pick<ProfilePreferences, 'getSettings' | 'onSettingsChanged'>,
    private readonly hookServer: Pick<
      AgentHookServer,
      'subscribeStatusChanges' | 'subscribeStatusFreshness' | 'getStatusChangeSnapshot'
    >,
    now: () => number = Date.now
  ) {
    this.lease = new AgentAwakeStatusLease(now, () => this.refresh())
  }

  start(): void {
    this.unsubscribers.push(
      this.hookServer.subscribeStatusChanges((statuses: AgentAwakeStatus[]) => {
        this.lease.replace(statuses)
        this.refresh()
      }),
      this.hookServer.subscribeStatusFreshness((status: AgentAwakeStatus) => {
        if (this.lease.renew(status)) {
          this.refresh()
        }
      }),
      this.store.onSettingsChanged((updates) => {
        if ('computerAwakeMode' in updates || 'keepComputerAwakeWhileAgentsRun' in updates) {
          this.refresh()
        }
      })
    )
    // Seed from the snapshot so statuses observed before the first client
    // subscribed still count.
    this.lease.replace(this.hookServer.getStatusChangeSnapshot())
    this.refresh()
  }

  getStatus(): ComputerAwakeStatus {
    const settings = this.store.getSettings()
    const mode = normalizeComputerAwakeMode(
      settings.computerAwakeMode,
      settings.keepComputerAwakeWhileAgentsRun
    )
    return { mode, active: mode === 'on' || (mode === 'auto' && this.lease.countEligible() > 0) }
  }

  subscribe(listener: AgentAwakeStatusListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribers.splice(0)) {
      unsubscribe()
    }
    this.listeners.clear()
    this.lease.dispose()
  }

  private refresh(): void {
    const status = this.getStatus()
    if (this.lastPublished?.mode === status.mode && this.lastPublished.active === status.active) {
      return
    }
    this.lastPublished = status
    for (const listener of this.listeners) {
      try {
        listener(status)
      } catch (error) {
        console.warn('[orcad] agent-awake listener threw:', error)
      }
    }
  }
}
