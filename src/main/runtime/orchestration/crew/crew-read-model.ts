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
  private readonly trafficAddresses = new Set<string>()
  private broadTraffic = false
  private unwatch: (() => void) | undefined

  constructor(
    private readonly readDependencies: (previous?: CrewReadDependencies) => CrewReadDependencies,
    private readonly watch: (wake: (facets: CrewInvalidation) => void) => () => void
  ) {}

  private invalidate = (facets: CrewInvalidation) => {
    for (const id of facets.recordIds ?? []) {
      this.renamed.add(id)
    }
    if (facets.has('traffic')) {
      if (facets.trafficAddresses) {
        for (const address of facets.trafficAddresses) {
          this.trafficAddresses.add(address)
        }
      } else {
        this.broadTraffic = true
      }
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
        this.trafficAddresses.clear()
        this.broadTraffic = false
        this.renamed.clear()
      }
    }
  }

  read = (address: string): OrchestrationCrewSnapshot => {
    const now = Date.now()
    const dirty = new Set(this.dirty)
    const renamed = new Set(this.renamed)
    const trafficAddresses = this.broadTraffic ? undefined : new Set(this.trafficAddresses)
    this.dirty.clear()
    this.renamed.clear()
    this.trafficAddresses.clear()
    this.broadTraffic = false
    if (
      !this.host ||
      dirty.has('topology') ||
      dirty.has('records') ||
      now < this.host.now ||
      now >= this.host.expiresAt
    ) {
      const previous = this.host
      this.host = undefined
      let deps = this.readDependencies()
      if (previous && this.listeners.size && !dirty.has('records')) {
        previous.registry.refreshRecordNames(deps.records, renamed)
        deps = { ...deps, records: previous.deps.records }
      }
      // A one-shot read has no watch to keep captured truth current.
      const host = createCrewHostDerivation(deps, deps.now ?? now, () =>
        Math.max(32, this.listeners.size * 2)
      )
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
        previous.registry.refreshRecordNames(deps.records, renamed)
        this.host = isDeepStrictEqual(identities(previous.deps.statuses), identities(statuses))
          ? refreshCrewStatuses(previous, statuses)
          : createCrewHostDerivation(
              { ...sources, records: previous.deps.records, statuses },
              now,
              () => Math.max(32, this.listeners.size * 2)
            )
      } else {
        this.host = previous
      }
      this.host.registry.refreshRecordNames(deps.records, renamed)
      this.host = {
        ...this.host,
        deps: {
          ...this.host.deps,
          name: deps.name,
          openIdentityRead: deps.openIdentityRead
        }
      }
    }
    if (dirty.has('traffic')) {
      this.host.sourceInputs.invalidateTraffic(trafficAddresses)
    }
    return buildCrewSnapshot(address, { ...this.host.deps, now }, this.host)
  }
}
