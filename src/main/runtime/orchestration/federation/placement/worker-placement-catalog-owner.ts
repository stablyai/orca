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
import { observeEnvironmentStoreReads } from '../../../../../shared/remote-runtime/host-store/runtime-environment-store-read-observation'
import { environmentStoreWriteCount } from '../../../../../shared/remote-runtime/host-store/runtime-environment-store-worker-client'
import type { RuntimeRequestGuard } from '../../../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import type { CatalogReadFailure } from './worker-placement-catalog'
import { readWorkerPlacementCatalog } from './worker-placement-catalog-read'

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

type Flight = { server: OrchestrationWorkerServer; promise: Promise<ReadResult> }

/** Shipped discovery owner, idle until queried; no sidebar, worker-start or Run dependency. */
export class WorkerPlacementCatalogOwner {
  private readonly flights = new Map<string, Flight>()
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
    const reconcile = (): void => {
      this.dirty = true
      this.reconciliation ??= this.reconcileUntilCurrent().finally(() => {
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
    let expire: ReturnType<typeof setTimeout> | undefined
    const budget = new Promise<null>((resolve) => {
      expire = setTimeout(() => resolve(null), DISCOVERY_MS)
    })
    try {
      const servers = environmentId
        ? [{ environmentId, name: environmentId }]
        : ((await this.transport.list?.()) ?? [])
      const snapshots = await Promise.all(
        servers.map(async ({ environmentId, name }): Promise<PlacementCatalogSnapshot> => {
          const initial = await observeEnvironmentStoreReads(
            async () => await this.transport!.resolve(environmentId),
            environmentStoreWriteCount
          ).catch(() => null)
          if (this.stopped || !initial?.current) {
            return { server: { environmentId, name }, status: 'unchecked', reason: 'no_answer' }
          }
          const server = initial.value
          const pin = remoteServerPin(server)
          const retained = this.retainedCatalog(server)
          if (retained && Date.now() - retained.observedAt < FRESH_MS) {
            return { server, status: 'fresh', ...retained } satisfies PlacementCatalogSnapshot
          }
          const result = await Promise.race([this.read(server), budget])
          const current = await observeEnvironmentStoreReads(
            async () => await this.transport!.resolve(environmentId),
            environmentStoreWriteCount
          ).catch(() => null)
          if (
            this.stopped ||
            !current?.current ||
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
      clearTimeout(expire)
    }
  }

  private read(server: OrchestrationWorkerServer): Promise<ReadResult> {
    const previous = this.flights.get(server.environmentId)
    if (previous) {
      return remoteRunLinkPinMatches(remoteServerPin(previous.server), remoteServerPin(server))
        ? previous.promise
        : Promise.resolve({ kind: 'failed', reason: 'no_answer' })
    }
    const flight: Flight = {
      server,
      promise: Promise.resolve({ kind: 'failed', reason: 'no_answer' })
    }
    this.flights.set(server.environmentId, flight)
    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<ReadResult>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true
        resolve({ kind: 'failed', reason: 'no_answer' })
      }, READ_MS)
    })
    const work = this.fetch(server, () => !timedOut)
      .catch((): ReadResult => ({ kind: 'failed', reason: 'no_answer' }))
      .finally(() => {
        clearTimeout(timer)
        // Keep a timed-out transport occupying its slot until it actually settles.
        if (this.flights.get(server.environmentId) === flight) {
          this.flights.delete(server.environmentId)
        }
      })
    flight.promise = Promise.race([work, timeout])
    return flight.promise
  }

  private async fetch(
    server: OrchestrationWorkerServer,
    withinDeadline: () => boolean
  ): Promise<ReadResult> {
    const transport = this.transport!
    const pin = remoteServerPin(server)
    const prepareGuard: RuntimeRequestGuard = async (connection) => {
      const observation = await observeEnvironmentStoreReads(
        async () => await transport.resolve(server.environmentId),
        environmentStoreWriteCount
      )
      const generation = environmentStoreWriteCount()
      const peers = pairedOrchestrationPeers(
        connection.hostPublicKeyB64,
        connection.credential.deviceToken
      )
      return () => {
        if (
          this.stopped ||
          !withinDeadline() ||
          !observation.current ||
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
    if (this.stopped || !withinDeadline()) {
      return { kind: 'failed', reason: 'no_answer' }
    }
    const current = await observeEnvironmentStoreReads(
      async () => await transport.resolve(server.environmentId),
      environmentStoreWriteCount
    )
    if (
      this.stopped ||
      !withinDeadline() ||
      !current.current ||
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
      const transport = this.transport!
      const servers = (await transport.list?.()) ?? []
      const live = new Set(servers.map((server) => server.environmentId))
      for (const id of this.retained.keys()) {
        if (!live.has(id)) {
          this.retained.delete(id)
        }
      }
      if (this.stopped) {
        return
      }
      const rows = this.db.db.prepare('SELECT environment_id FROM worker_placement_catalogs').all()
      await Promise.all(
        rows.map(async ({ environment_id }) => {
          if (typeof environment_id !== 'string') {
            return
          }
          if (!live.has(environment_id)) {
            deleteRetainedPlacementCatalog(this.db, environment_id)
            return
          }
          const current = await transport.resolve(environment_id)
          if (!this.stopped) {
            this.retainedCatalog(current)
          }
        })
      )
    } while (this.dirty && !this.stopped)
  }
}
