import {
  agentActivitySubjectKey,
  type AgentActivityReadState
} from '../../../src/shared/agent-activity-read-state'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { runRpcOperation } from '../transport/rpc/rpc-operation'
import { activityReadSnapshot, activityReadWrite } from './host-activity-read-operations'

export type HostActivityReadSnapshot = {
  status: 'loading' | 'ready' | 'unsupported' | 'error'
  activities: ReadonlyMap<string, AgentActivityReadState>
  pending: ReadonlySet<string>
}

export const EMPTY_ACTIVITY_READ_SNAPSHOT: HostActivityReadSnapshot = {
  status: 'loading',
  activities: new Map(),
  pending: new Set()
}

export class HostActivityReadModel {
  private active = false
  private generation = 0
  private revision = 0
  private flight: Promise<void> | null = null
  private queued = false
  private listeners = new Set<() => void>()
  private pending = new Set<string>()
  private snapshot: HostActivityReadSnapshot = EMPTY_ACTIVITY_READ_SNAPSHOT

  constructor(private readonly client: RpcClient) {}

  getSnapshot = (): HostActivityReadSnapshot => this.snapshot
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  setActive(active: boolean): void {
    this.active = active
    this.generation++
  }

  private publish(patch: Partial<HostActivityReadSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch, pending: new Set(this.pending) }
    for (const listener of this.listeners) {
      listener()
    }
  }

  refresh(force = false): Promise<void> {
    if (!this.active || (!force && this.snapshot.status === 'unsupported')) {
      return Promise.resolve()
    }
    if (this.flight) {
      this.queued = true
      return this.flight
    }
    const generation = this.generation
    const revision = this.revision
    const run = async (): Promise<void> => {
      try {
        const result = await runRpcOperation(this.client, activityReadSnapshot, null)
        if (this.active && generation === this.generation && revision !== this.revision) {
          this.queued = true
        }
        if (!this.active || generation !== this.generation || revision !== this.revision) {
          return
        }
        this.publish({
          status: result.available ? 'ready' : 'loading',
          activities: new Map(
            result.activities.map((entry) => [agentActivitySubjectKey(entry), entry])
          )
        })
      } catch (error) {
        if (!this.active || generation !== this.generation || revision !== this.revision) {
          return
        }
        const unsupported =
          error instanceof Error && /^(method_not_found|forbidden):/.test(error.message)
        this.publish(
          unsupported ? { status: 'unsupported', activities: new Map() } : { status: 'error' }
        )
      }
    }
    this.flight = run().finally(() => {
      this.flight = null
      if (this.queued) {
        this.queued = false
        if (this.active) {
          void this.refresh()
        }
      }
    })
    return this.flight
  }

  async setRead(activity: AgentActivityReadState, read: boolean): Promise<void> {
    const key = agentActivitySubjectKey(activity)
    if (!this.active || this.pending.has(key) || this.snapshot.status !== 'ready') {
      return
    }
    const generation = this.generation
    this.revision++
    this.pending.add(key)
    this.publish({})
    try {
      const result = await runRpcOperation(this.client, activityReadWrite, {
        paneKey: activity.paneKey,
        worktreeId: activity.worktreeId,
        hostId: activity.hostId,
        latestActivityAt: activity.latestActivityAt,
        read
      })
      if (!this.active || generation !== this.generation) {
        return
      }
      if (agentActivitySubjectKey(result) !== key) {
        throw new Error('Notification read target changed')
      }
      this.revision++
      const activities = new Map(this.snapshot.activities)
      activities.set(key, result)
      this.publish({ activities })
    } catch (error) {
      if (this.active && generation === this.generation) {
        throw error
      }
    } finally {
      this.revision++
      this.pending.delete(key)
      this.publish({})
    }
  }
}
