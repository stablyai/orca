import type { OrchestrationDb } from '../../db/orchestration-db'
import {
  deleteRetainedPlacementCatalog,
  readRetainedPlacementCatalog,
  writeRetainedPlacementCatalog,
  type RetainedPlacementCatalog
} from '../../db/remote-owned/worker-placement-catalog-store'
import { remoteServerPin, remoteRunLinkPinMatches } from '../../db/remote-owned/remote-run-links'
import {
  pairedOrchestrationPeers,
  type OrchestrationEnvironmentTransport,
  type OrchestrationWorkerServer
} from '../environment-transport'
import { OrchestrationError } from '../../orchestration-error'
import { environmentStoreWriteCount } from '../../../../../shared/remote-runtime/host-store/runtime-environment-store-worker-client'
import type { RuntimeRequestGuard } from '../../../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import type { CatalogReadFailure } from './worker-placement-catalog'
import { readWorkerPlacementCatalog } from './worker-placement-catalog-read'
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
    { server: OrchestrationWorkerServer; value: RetainedPlacementCatalog | undefined }
  >()
  private stopped = false
  private readonly stopWatch: (() => void) | undefined
  private reconciliation: Promise<void> | undefined
  private dirty = false

  constructor(
    readonly db: OrchestrationDb,
    private readonly transport: OrchestrationEnvironmentTransport | null
  ) {
    this.registry = transport ? new CatalogOwnerRegistry(transport) : undefined
    const reconcile = (): void => {
      this.registry!.invalidate()
      this.dirty = true
      if (this.reconciliation) {
        return
      }
      this.reconciliation = this.reconcileUntilCurrent().finally(() => {
        this.reconciliation = undefined
      })
      void this.reconciliation.catch((error: unknown) =>
        console.warn('[worker-placement] Catalog pairing reconciliation failed', error)
      )
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
    this.retained.clear()
  }

  private retainedCatalog(server: OrchestrationWorkerServer): RetainedPlacementCatalog | undefined {
    const previous = this.retained.get(server.environmentId)
    if (
      previous &&
      remoteRunLinkPinMatches(remoteServerPin(previous.server), remoteServerPin(server))
    ) {
      return previous.value
    }
    const value = readRetainedPlacementCatalog(this.db, remoteServerPin(server))
    this.retained.set(server.environmentId, { server, value })
    return value
  }

  async discover(environmentId?: string): Promise<PlacementCatalogSnapshot[]> {
    if (this.stopped || !this.transport) {
      return []
    }
    const deadline = new CatalogDeadline(DISCOVERY_MS)
    try {
      const registered = await this.registry!.list(deadline)
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
          if (this.stopped || !this.registry!.isCurrent(initial)) {
            return { server: { environmentId, name }, status: 'unchecked', reason: 'no_answer' }
          }
          const server = initial.value
          const pin = remoteServerPin(server)
          const retained = this.retainedCatalog(server)
          if (retained && Date.now() - retained.observedAt < FRESH_MS) {
            return { server, status: 'fresh', ...retained } satisfies PlacementCatalogSnapshot
          }
          const result = await this.read(server, deadline)
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
          return retained
            ? ({
                server,
                status: 'retained',
                reason,
                ...retained
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
    deadline: CatalogDeadline
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
          return await this.fetch(server, hard)
        } finally {
          hard.close()
          // A stalled transport keeps its slot even after its response deadline.
          this.flights.delete(server.environmentId)
        }
      })
      return (await work.wait(hard)) ?? { kind: 'failed', reason: 'no_answer' }
    })
    this.flights.set(server.environmentId, { server, pending })
    return pending.wait(deadline)
  }

  private async fetch(
    server: OrchestrationWorkerServer,
    deadline: CatalogDeadline
  ): Promise<ReadResult> {
    const transport = this.transport!
    const pin = remoteServerPin(server)
    const prepareGuard: RuntimeRequestGuard = async (connection) => {
      const observation = await this.registry!.resolve(server.environmentId, deadline)
      const generation = environmentStoreWriteCount()
      const peers = pairedOrchestrationPeers(
        connection.hostPublicKeyB64,
        connection.credential.deviceToken
      )
      return () => {
        if (
          this.stopped ||
          !deadline.active ||
          !this.registry!.isCurrent(observation) ||
          generation !== environmentStoreWriteCount()
        ) {
          return false
        }
        if (
          !remoteRunLinkPinMatches(pin, remoteServerPin(observation.value)) ||
          peers.peerFingerprint !== pin.peer_fingerprint ||
          peers.homePeerFingerprint !== pin.home_fingerprint
        ) {
          throw new OrchestrationError(
            'server_pairing_changed',
            'Catalog read belongs to an earlier pairing.'
          )
        }
        return true
      }
    }
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
      deleteRetainedPlacementCatalog(this.db, server.environmentId)
      this.retained.delete(server.environmentId)
      return read
    }
    if (read.kind === 'failed') {
      return read
    }
    const value = { observedAt: Date.now(), catalog: read.catalog }
    writeRetainedPlacementCatalog(this.db, pin, value)
    this.retained.set(server.environmentId, { server, value })
    return { kind: 'complete', value }
  }

  private async reconcileUntilCurrent(): Promise<void> {
    do {
      this.dirty = false
      const deadline = new CatalogDeadline()
      try {
        const servers = await this.registry!.list(deadline)
        if (this.stopped) {
          return
        }
        const live = new Set(servers.map((server) => server.environmentId))
        for (const id of this.retained.keys()) {
          if (!live.has(id)) {
            this.retained.delete(id)
          }
        }
        const rows = this.db.db
          .prepare('SELECT environment_id FROM worker_placement_catalogs')
          .all()
        await Promise.all(
          rows.map(async ({ environment_id }) => {
            if (typeof environment_id !== 'string') {
              return
            }
            if (!live.has(environment_id)) {
              deleteRetainedPlacementCatalog(this.db, environment_id)
              return
            }
            const current = await this.registry!.resolve(environment_id, deadline)
            if (!this.stopped && this.registry!.isCurrent(current)) {
              this.retainedCatalog(current.value)
            } else if (current) {
              this.dirty = true
            }
          })
        )
      } finally {
        deadline.close()
      }
    } while (this.dirty && !this.stopped)
  }
}
