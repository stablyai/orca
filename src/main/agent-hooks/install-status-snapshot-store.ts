import type {
  AgentHookInstallStatus,
  AgentHookInstallStatusSnapshot,
  AgentHookTarget
} from '../../shared/agent-hook-types'
import type { SnapshotAvailability } from '../../shared/memory-snapshot'

type SnapshotEntry = {
  value: AgentHookInstallStatus | null
  stale: boolean
  availability: SnapshotAvailability
  observedAt: number | null
  lastError: string | null
  generation: number
}

type RefreshReader = () => Promise<AgentHookInstallStatus>

const LOCAL_SCOPE = 'local'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function failureAvailability(
  error: unknown
): Extract<SnapshotAvailability, 'denied' | 'unavailable'> {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'EACCES' || code === 'EPERM' ? 'denied' : 'unavailable'
}

function statusAvailability(status: AgentHookInstallStatus): SnapshotAvailability {
  if (status.state === 'not_installed') {
    return 'missing'
  }
  return status.state === 'error' ? 'unavailable' : 'ready'
}

function unavailableStatus(agent: AgentHookTarget, detail: string | null): AgentHookInstallStatus {
  return {
    agent,
    state: 'error',
    configPath: '',
    managedHooksPresent: false,
    detail: detail ?? 'Hook installation status has not been inspected.'
  }
}

export class AgentHookInstallStatusSnapshotStore {
  private readonly entries = new Map<string, SnapshotEntry>()
  private readonly inFlight = new Map<string, Promise<AgentHookInstallStatusSnapshot>>()

  constructor(private readonly now: () => number = Date.now) {}

  read(agent: AgentHookTarget, scope = LOCAL_SCOPE): AgentHookInstallStatusSnapshot {
    const entry = this.entries.get(this.key(agent, scope))
    const value = entry?.value ?? unavailableStatus(agent, entry?.lastError ?? null)
    return {
      ...value,
      value: entry?.value ?? null,
      stale: entry?.stale ?? true,
      age:
        entry?.observedAt === null || entry?.observedAt === undefined
          ? null
          : Math.max(0, this.now() - entry.observedAt),
      availability: entry?.availability ?? 'unavailable',
      lastError: entry?.lastError ?? null
    }
  }

  publish(status: AgentHookInstallStatus, scope = LOCAL_SCOPE): void {
    const key = this.key(status.agent, scope)
    const previous = this.entries.get(key)
    this.entries.set(key, {
      value: status,
      stale: false,
      availability: statusAvailability(status),
      observedAt: this.now(),
      lastError: null,
      generation: (previous?.generation ?? 0) + 1
    })
  }

  publishAll(statuses: readonly AgentHookInstallStatus[], scope = LOCAL_SCOPE): void {
    for (const status of statuses) {
      this.publish(status, scope)
    }
  }

  invalidate(agent: AgentHookTarget, error?: unknown, scope = LOCAL_SCOPE): void {
    const key = this.key(agent, scope)
    const previous = this.entries.get(key)
    this.entries.set(key, {
      value: previous?.value ?? null,
      stale: true,
      availability: failureAvailability(error),
      observedAt: previous?.observedAt ?? null,
      lastError: error === undefined ? null : errorMessage(error),
      generation: (previous?.generation ?? 0) + 1
    })
  }

  refresh(
    agent: AgentHookTarget,
    reader: RefreshReader,
    scope = LOCAL_SCOPE
  ): Promise<AgentHookInstallStatusSnapshot> {
    const key = this.key(agent, scope)
    const existing = this.inFlight.get(key)
    if (existing) {
      return existing
    }
    const generation = this.entries.get(key)?.generation ?? 0
    const refresh = Promise.resolve()
      .then(reader)
      .then((status) => {
        if ((this.entries.get(key)?.generation ?? 0) === generation) {
          this.publish(status, scope)
        }
        return this.read(agent, scope)
      })
      .catch((error: unknown) => {
        if ((this.entries.get(key)?.generation ?? 0) === generation) {
          this.invalidate(agent, error, scope)
        }
        return this.read(agent, scope)
      })
      .finally(() => {
        if (this.inFlight.get(key) === refresh) {
          this.inFlight.delete(key)
        }
      })
    this.inFlight.set(key, refresh)
    return refresh
  }

  clearScope(scope: string): void {
    const prefix = `${scope}\0`
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) {
        this.entries.delete(key)
      }
    }
  }

  resetForTests(): void {
    this.entries.clear()
    this.inFlight.clear()
  }

  private key(agent: AgentHookTarget, scope: string): string {
    return `${scope}\0${agent}`
  }
}

export const agentHookInstallStatusSnapshots = new AgentHookInstallStatusSnapshotStore()
