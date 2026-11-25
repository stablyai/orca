import type { OrchestrationDb } from '../../db/orchestration-db'
import {
  deleteRetainedPlacementCatalog,
  readRetainedPlacementCatalog,
  writeRetainedPlacementCatalog,
  type StoredPlacementCatalog,
  type RetainedPlacementCatalog
} from '../../db/remote-owned/worker-placement-catalog-store'
import { remoteServerPin, remoteRunLinkPinMatches } from '../../db/remote-owned/remote-run-links'
import type {
  OrchestrationEnvironmentTransport,
  OrchestrationWorkerServer
} from '../environment-transport'
import type { CatalogReadFailure } from './worker-placement-catalog'
import { readWorkerPlacementCatalog } from './worker-placement-catalog-read'
import { workerPlacementCatalogGuard } from './worker-placement-catalog-guard'
import {
  CatalogDeadline,
  CatalogOwnerRead,
  CatalogOwnerRegistry
} from './worker-placement-catalog-deadline'

const FRESH_MS = 30_000
const DISCOVERY_MS = 5_000
const READ_MS = 15_000

type ReadResult =
  | { kind: 'complete'; value: RetainedPlacementCatalog }
  | { kind: 'unsupported' }
  | { kind: 'failed'; reason: CatalogReadFailure }
export type PlacementCatalogSnapshot = {
  server: Pick<OrchestrationWorkerServer, 'environmentId' | 'name'>
} & (
  | ({ status: 'fresh' | 'retained'; reason?: CatalogReadFailure } & RetainedPlacementCatalog)
  | { status: 'unchecked'; reason: CatalogReadFailure }
  | { status: 'unsupported' }
)

type Flight = { server: OrchestrationWorkerServer; pending: CatalogOwnerRead<ReadResult> }

/** Shipped discovery owner, idle until queried; no sidebar, worker-start or Run dependency. */
export class WorkerPlacementCatalogOwner {
  private readonly flights = new Map<string, Flight>()
  private readonly registry: CatalogOwnerRegistry | undefined
  private readonly retained = new Map<
    string,
    { server: OrchestrationWorkerServer; stored: StoredPlacementCatalog | undefined }
  >()
  private stopped = false
  private readonly stopWatch: (() => void) | undefined
  private reconciliation: CatalogDeadline | undefined
  private dirty = false

  constructor(
    readonly db: OrchestrationDb,
    private readonly transport: OrchestrationEnvironmentTransport | null
  ) {
    this.registry = transport ? new CatalogOwnerRegistry(transport) : undefined
    const reconcile = (): void => {
      this.registry!.invalidate()
      this.dirty = true
      if (!this.reconciliation) {
        void this.reconcileUntilCurrent()
      }
    }
    this.stopWatch = transport?.onCatalogChanged?.(reconcile)
    if (transport) {
      reconcile()
    }
    db.onClose(() => this.dispose())
  }

  dispose(): void {
    this.stopped = true
    this.stopWatch?.()
    this.reconciliation?.close()
    this.retained.clear()
  }

  private retainedCatalog(server: OrchestrationWorkerServer): StoredPlacementCatalog | undefined {
    const previous = this.retained.get(server.environmentId)
    if (
      previous &&
      remoteRunLinkPinMatches(remoteServerPin(previous.server), remoteServerPin(server))
    ) {
      return previous.stored
    }
    const stored = readRetainedPlacementCatalog(this.db, remoteServerPin(server))
    this.retained.set(server.environmentId, { server, stored })
    return stored
  }

  async discover(environmentId?: string): Promise<PlacementCatalogSnapshot[]> {
    if (this.stopped || !this.transport) {
      return []
    }
    const deadline = new CatalogDeadline(DISCOVERY_MS)
    try {
      const registered = this.registry!.currentServers(await this.registry!.list(deadline))
      const selected = environmentId
        ? registered.find((server) => server.environmentId === environmentId)
        : undefined
      if (environmentId && !selected) {
        return [
          {
            server: { environmentId, name: environmentId },
            status: 'unchecked',
            reason: 'no_answer'
          }
        ]
      }
      const servers = selected ? [selected] : registered
      const snapshots = await Promise.all(
        servers.map(async ({ environmentId, name }): Promise<PlacementCatalogSnapshot> => {
          const initial = await this.registry!.resolve(environmentId, deadline)
          if (this.stopped || !this.registry!.isCurrent(initial, environmentId)) {
            return { server: { environmentId, name }, status: 'unchecked', reason: 'no_answer' }
          }
          const server = initial.value
          const pin = remoteServerPin(server)
          const stored = this.retainedCatalog(server)
          const retained = stored?.value
          const age = retained ? Date.now() - retained.observedAt : Infinity
          if (retained && age >= 0 && age < FRESH_MS) {
            return { server, status: 'fresh', ...retained } satisfies PlacementCatalogSnapshot
          }
          const result = await this.read(server, deadline, stored?.version ?? null)
          const current = deadline.active
            ? await this.registry!.resolve(environmentId, deadline)
            : this.registry!.current(environmentId)
          if (
            this.stopped ||
            !this.registry!.isCurrent(current) ||
            !remoteRunLinkPinMatches(pin, remoteServerPin(current.value))
          ) {
            return {
              server,
              status: 'unchecked',
              reason: 'no_answer'
            } satisfies PlacementCatalogSnapshot
          }
          if (result?.kind === 'complete') {
            return { server, status: 'fresh', ...result.value } satisfies PlacementCatalogSnapshot
          }
          if (result?.kind === 'unsupported') {
            return { server, status: 'unsupported' } satisfies PlacementCatalogSnapshot
          }
          const reason = result?.kind === 'failed' ? result.reason : 'no_answer'
          const latest = this.retainedCatalog(current.value)?.value
          return latest
            ? ({
                server,
                status: 'retained',
                reason,
                ...latest
              } satisfies PlacementCatalogSnapshot)
            : ({ server, status: 'unchecked', reason } satisfies PlacementCatalogSnapshot)
        })
      )
      return snapshots
    } finally {
      deadline.close()
    }
  }

  private read(
    server: OrchestrationWorkerServer,
    deadline: CatalogDeadline,
    previousVersion: string | null
  ): Promise<ReadResult | undefined> {
    if (!deadline.active || this.stopped) {
      return Promise.resolve(undefined)
    }
    const previous = this.flights.get(server.environmentId)
    if (previous) {
      return remoteRunLinkPinMatches(remoteServerPin(previous.server), remoteServerPin(server))
        ? previous.pending.wait(deadline)
        : Promise.resolve({ kind: 'failed', reason: 'no_answer' })
    }
    const pending = new CatalogOwnerRead<ReadResult>(async () => {
      const hard = new CatalogDeadline(READ_MS)
      const work = new CatalogOwnerRead<ReadResult>(async () => {
        try {
          if (!deadline.active || this.stopped) {
            return { kind: 'failed', reason: 'no_answer' }
          }
          return await this.fetch(server, hard, previousVersion)
        } finally {
          // A stalled transport keeps its slot even after its response deadline.
          this.flights.delete(server.environmentId)
        }
      })
      try {
        return (await work.wait(hard)) ?? { kind: 'failed', reason: 'no_answer' }
      } finally {
        hard.close()
      }
    })
    this.flights.set(server.environmentId, { server, pending })
    return pending.wait(deadline)
  }

  private async fetch(
    server: OrchestrationWorkerServer,
    deadline: CatalogDeadline,
    previousVersion: string | null
  ): Promise<ReadResult> {
    const transport = this.transport!
    const pin = remoteServerPin(server)
    const prepareGuard = workerPlacementCatalogGuard(
      this.registry!,
      server,
      deadline,
      () => this.stopped
    )
    const read = await readWorkerPlacementCatalog(transport, server, prepareGuard)
    if (this.stopped || !deadline.active) {
      return { kind: 'failed', reason: 'no_answer' }
    }
    const current = await this.registry!.resolve(server.environmentId, deadline)
    if (
      this.stopped ||
      !deadline.active ||
      !this.registry!.isCurrent(current) ||
      !remoteRunLinkPinMatches(pin, remoteServerPin(current.value))
    ) {
      return { kind: 'failed', reason: 'no_answer' }
    }
    if (read.kind === 'unsupported') {
      deleteRetainedPlacementCatalog(this.db, server.environmentId, previousVersion)
      this.retained.delete(server.environmentId)
      return read
    }
    if (read.kind === 'failed') {
      return read
    }
    const value = { observedAt: Date.now(), catalog: read.catalog }
    const stored = writeRetainedPlacementCatalog(this.db, pin, previousVersion, value)
    if (!stored) {
      this.retained.delete(server.environmentId)
      return { kind: 'failed', reason: 'incomplete' }
    }
    this.retained.set(server.environmentId, { server, stored })
    return { kind: 'complete', value }
  }

  private async reconcileUntilCurrent(): Promise<void> {
    do {
      this.dirty = false
      const deadline = new CatalogDeadline()
      this.reconciliation = deadline
      try {
        const enumeration = await this.registry!.list(deadline)
        if (this.stopped) {
          break
        }
        const servers = this.registry!.currentServers(enumeration)
        const live = new Set(servers.map((server) => server.environmentId))
        const rows = this.db.db
          .prepare('SELECT environment_id FROM worker_placement_catalogs')
          .all()
        const saved = rows.some(
          ({ environment_id }) => typeof environment_id === 'string' && !live.has(environment_id)
        )
          ? await this.registry!.savedEnvironmentIds(deadline)
          : undefined
        await Promise.all(
          rows.map(async ({ environment_id }) => {
            if (typeof environment_id !== 'string') {
              return
            }
            if (!live.has(environment_id)) {
              if (!this.stopped && this.registry!.isRemoved(saved, environment_id)) {
                deleteRetainedPlacementCatalog(this.db, environment_id)
                this.retained.delete(environment_id)
              }
              return
            }
            let current = await this.registry!.resolve(environment_id, deadline)
            // This pass may have joined a pairing read started before its notification.
            if (!this.stopped && !this.dirty && current && !this.registry!.isCurrent(current)) {
              current = await this.registry!.resolve(environment_id, deadline)
            }
            if (!this.stopped && this.registry!.isCurrent(current, environment_id)) {
              this.retainedCatalog(current.value)
            }
          })
        )
      } catch (error) {
        console.warn('[worker-placement] Catalog pairing reconciliation failed', error)
      } finally {
        deadline.close()
      }
    } while (this.dirty && !this.stopped)
    this.reconciliation = undefined
  }
}
