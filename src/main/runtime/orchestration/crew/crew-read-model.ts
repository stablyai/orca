import { isDeepStrictEqual } from 'node:util'
import type { CrewFacet, CrewInvalidation } from './crew-changes'
import { buildCrewSnapshot, type CrewReadDependencies } from './crew-party-snapshot'
import type { OrchestrationCrewSnapshot } from '../../../../shared/orchestration-crew'
import {
  createCrewHostDerivation,
  refreshCrewStatuses,
  type CrewHostDerivation
} from './crew-host-derivation'
export { buildCrewSnapshot, type CrewReadDependencies } from './crew-party-snapshot'

/** One host derivation is shared by all mounted parties; the last subscriber releases its inputs. */
export class CrewReadModel {
  private host: CrewHostDerivation | undefined
  private readonly listeners = new Set<() => void>()
  private readonly renamed = new Set<string>()
  private readonly dirty = new Set<CrewFacet>()
  private unwatch: (() => void) | undefined

  constructor(
    private readonly readDependencies: (previous?: CrewReadDependencies) => CrewReadDependencies,
    private readonly watch: (wake: (facets: CrewInvalidation) => void) => () => void
  ) {}

  private invalidate = (facets: CrewInvalidation) => {
    for (const id of facets.recordIds ?? []) {
      this.renamed.add(id)
    }
    for (const facet of facets) {
      this.dirty.add(facet)
    }
    for (const listener of this.listeners) {
      listener()
    }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    this.unwatch ??= this.watch(this.invalidate)
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) {
        this.unwatch?.()
        this.unwatch = undefined
        this.host = undefined
        this.dirty.clear()
        this.renamed.clear()
      }
    }
  }

  read = (address: string): OrchestrationCrewSnapshot => {
    const now = Date.now()
    const dirty = new Set(this.dirty)
    const renamed = new Set(this.renamed)
    this.dirty.clear()
    this.renamed.clear()
    if (
      !this.host ||
      dirty.has('topology') ||
      dirty.has('records') ||
      now < this.host.now ||
      now >= this.host.expiresAt
    ) {
      this.host = undefined
      const deps = this.readDependencies()
      // A one-shot read has no watch to keep captured truth current.
      const host = createCrewHostDerivation(deps, deps.now ?? now)
      if (this.listeners.size === 0) {
        return buildCrewSnapshot(address, { ...host.deps, now }, host)
      }
      this.host = host
    } else if (dirty.has('status') || dirty.has('names')) {
      const previous = this.host
      this.host = undefined
      const deps = this.readDependencies(previous.deps)
      if (dirty.has('status')) {
        const { statuses, ...sources } = deps
        const identities = (rows: typeof statuses) =>
          new Map(rows.map((row) => [row.activity.paneKey, row.binding]))
        this.host = isDeepStrictEqual(identities(previous.deps.statuses), identities(statuses))
          ? refreshCrewStatuses(previous, statuses)
          : createCrewHostDerivation({ ...sources, statuses }, now)
      } else {
        this.host = previous
      }
      let records = this.host.deps.records
      if (renamed.size && records) {
        const captured = new Map(records.listRecords().map((record) => [record.sessionId, record]))
        for (const id of renamed) {
          const record = deps.records?.getRecord(id)
          if (record) {
            captured.set(id, record)
          }
        }
        records = {
          ...records,
          getRecord: (id) => captured.get(id) ?? null,
          listRecords: () => [...captured.values()]
        }
      }
      this.host = {
        ...this.host,
        deps: {
          ...this.host.deps,
          records,
          name: deps.name,
          openIdentityRead: deps.openIdentityRead
        }
      }
    }
    return buildCrewSnapshot(address, { ...this.host.deps, now }, this.host)
  }
}
