import type {
  DaemonGenerationResource,
  MaestroResourceInventory,
  MemorySnapshot,
  ResourceHealthState,
  RuntimeResourceHealth
} from '../../shared/process-stats-types'

const MAX_INVENTORY_IDENTITIES = 128
const DEFAULT_BACKOFF_MS = 1_000
const MAX_BACKOFF_MS = 30_000
const MEMORY_PRESSURE_PERCENT = 85

export type MaestroWorkerResource = {
  dispatchId: string
  resource?: {
    host_scope?: string | null
    worktree_id?: string | null
    process_root_pid?: number | null
  } | null
}

export type MaestroBrowserResource = {
  receipt: {
    surface_id: string
    execution_host_id?: string
    workspace_key?: string
    browser_page_id?: string | null
  }
}

export type HostResourceSnapshot = {
  state: ResourceHealthState
  reason: string | null
  collectedAt: number | null
  hostMemoryUsagePercent: number | null
  inventory: MaestroResourceInventory
}

export function buildMaestroResourceInventory(input: {
  memory: MemorySnapshot
  daemonGenerations: readonly DaemonGenerationResource[]
  workers?: readonly MaestroWorkerResource[]
  browserSurfaces?: readonly MaestroBrowserResource[]
}): HostResourceSnapshot {
  const workers = input.workers ?? []
  const browserSurfaces = input.browserSurfaces ?? []
  const processRoots = new Set<number>()
  for (const worktree of input.memory.worktrees) {
    for (const session of worktree.sessions) {
      if (session.pid > 0) {
        processRoots.add(session.pid)
      }
    }
  }
  for (const generation of input.daemonGenerations) {
    if (generation.processRootPid !== null) {
      processRoots.add(generation.processRootPid)
    }
  }
  for (const worker of workers) {
    const pid = worker.resource?.process_root_pid
    if (typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0) {
      processRoots.add(pid)
    }
  }
  const rendererCount = input.memory.app.rendererProcessCount
  const unavailableDaemon = input.daemonGenerations.some((generation) => generation.unverifiable)
  const hostMemoryUsagePercent = finiteOrNull(input.memory.host.memoryUsagePercent)
  const state = resourceState(
    hostMemoryUsagePercent,
    unavailableDaemon || rendererCount === undefined
  )
  return {
    state,
    reason:
      state === 'unverifiable'
        ? 'One or more daemon generations could not be verified.'
        : state === 'pressure'
          ? 'Host memory pressure is elevated.'
          : null,
    collectedAt: input.memory.collectedAt,
    hostMemoryUsagePercent,
    inventory: {
      daemonGenerations: [...input.daemonGenerations].slice(0, MAX_INVENTORY_IDENTITIES),
      workerIds: boundedUnique(workers.map((worker) => worker.dispatchId)),
      browserSurfaceIds: boundedUnique(
        browserSurfaces.map((surface) => surface.receipt.surface_id)
      ),
      processRootPids: [...processRoots].slice(0, MAX_INVENTORY_IDENTITIES),
      rendererCount: rendererCount ?? null,
      aggregateCpu: finiteOrNull(input.memory.totalCpu),
      aggregateMemory: finiteOrNull(input.memory.totalMemory)
    }
  }
}

type CollectorEntry = {
  generation: number
  inFlight: Promise<HostResourceSnapshot> | null
  cached: HostResourceSnapshot | null
  failures: number
  retryAt: number
  touchedAt: number
}

export class SharedExecutionHostResourceCollector {
  private readonly entries = new Map<string, CollectorEntry>()

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxHosts = 16
  ) {}

  async collect(
    scope: { executionHostId: string; workspaceKey: string; visible: boolean },
    load: () => Promise<HostResourceSnapshot>
  ): Promise<RuntimeResourceHealth> {
    if (!scope.visible) {
      return unavailableHealth(scope, 'Resource summary is hidden.')
    }
    const entry = this.entryFor(scope.executionHostId, scope.workspaceKey)
    entry.touchedAt = this.now()
    if (entry.retryAt > this.now()) {
      return entry.cached
        ? projectHealth(scope, entry.cached)
        : unavailableHealth(scope, 'Resource inventory is backing off after an unavailable host.')
    }
    if (!entry.inFlight) {
      const generation = entry.generation
      entry.inFlight = load()
        .then((snapshot) => {
          if (entry.generation === generation) {
            entry.cached = snapshot
            entry.failures = 0
            entry.retryAt = 0
          }
          return snapshot
        })
        .catch(() => {
          entry.failures += 1
          entry.retryAt = this.now() + backoffFor(entry.failures)
          return unverifiableSnapshot('Execution host resource data is unverifiable.', null)
        })
        .finally(() => {
          if (entry.generation === generation) {
            entry.inFlight = null
          }
        })
    }
    const snapshot = await entry.inFlight
    if (entry.generation !== 0 && entry.cached !== snapshot && snapshot.state !== 'unverifiable') {
      return unavailableHealth(scope, 'A stale resource response was discarded.')
    }
    return projectHealth(scope, snapshot)
  }

  invalidateHost(executionHostId: string): void {
    for (const [key, entry] of this.entries) {
      if (!key.startsWith(`${executionHostId}\0`)) {
        continue
      }
      entry.generation += 1
      entry.inFlight = null
      entry.cached = null
      entry.failures = 0
      entry.retryAt = 0
    }
  }

  private entryFor(executionHostId: string, workspaceKey: string): CollectorEntry {
    const key = `${executionHostId}\0${workspaceKey}`
    const existing = this.entries.get(key)
    if (existing) {
      return existing
    }
    const entry: CollectorEntry = {
      generation: 0,
      inFlight: null,
      cached: null,
      failures: 0,
      retryAt: 0,
      touchedAt: this.now()
    }
    this.entries.set(key, entry)
    this.evictIdleHosts()
    return entry
  }

  private evictIdleHosts(): void {
    while (this.entries.size > this.maxHosts) {
      const candidate = [...this.entries.entries()]
        .filter(([, entry]) => entry.inFlight === null)
        .sort((left, right) => left[1].touchedAt - right[1].touchedAt)[0]
      if (!candidate) {
        return
      }
      this.entries.delete(candidate[0])
    }
  }
}

function resourceState(
  memoryUsagePercent: number | null,
  unavailableDaemon: boolean
): ResourceHealthState {
  if (unavailableDaemon || memoryUsagePercent === null) {
    return 'unverifiable'
  }
  return memoryUsagePercent >= MEMORY_PRESSURE_PERCENT ? 'pressure' : 'normal'
}

function projectHealth(
  scope: { executionHostId: string; workspaceKey: string },
  snapshot: HostResourceSnapshot
): RuntimeResourceHealth {
  return {
    schemaVersion: 1,
    executionHostId: scope.executionHostId,
    workspaceKey: scope.workspaceKey,
    ...snapshot
  }
}

function unavailableHealth(
  scope: { executionHostId: string; workspaceKey: string },
  reason: string
): RuntimeResourceHealth {
  return projectHealth(scope, unverifiableSnapshot(reason, null))
}

function unverifiableSnapshot(reason: string, collectedAt: number | null): HostResourceSnapshot {
  return {
    state: 'unverifiable',
    reason,
    collectedAt,
    hostMemoryUsagePercent: null,
    inventory: {
      daemonGenerations: [],
      workerIds: [],
      browserSurfaceIds: [],
      processRootPids: [],
      rendererCount: null,
      aggregateCpu: null,
      aggregateMemory: null
    }
  }
}

function backoffFor(failures: number): number {
  return Math.min(DEFAULT_BACKOFF_MS * 2 ** Math.max(0, failures - 1), MAX_BACKOFF_MS)
}

function finiteOrNull(value: number): number | null {
  return Number.isFinite(value) && value >= 0 ? value : null
}

function boundedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].slice(0, MAX_INVENTORY_IDENTITIES)
}
