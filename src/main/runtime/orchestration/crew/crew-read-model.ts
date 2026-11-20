import { isDeepStrictEqual } from 'node:util'
import {
  CrewRelevance,
  crewIdentityFingerprint,
  type CrewFacet,
  type CrewInvalidation
} from './crew-changes'
import { buildCrewSnapshot } from './crew-party-snapshot'
import type { CrewReadDependencies } from './crew-read-dependencies'
import type { OrchestrationCrewSnapshot } from '../../../../shared/orchestration/orchestration-crew'
import { readCrewAssignmentIds } from './crew-query'
import {
  createCrewHostDerivation,
  patchCrewAssignmentStages,
  refreshCrewStatuses,
  type CrewHostDerivation
} from './crew-host-derivation'

/** One host derivation is shared by all mounted parties; the last subscriber releases its inputs. */
/** Past this many skipped Dispatches the next read rebuilds instead of tracking more. */
const STALE_CAP = 4096

export class CrewReadModel {
  private host: CrewHostDerivation | undefined
  /** What every mounted party's last read showed, together; a new object only when that changed. */
  private relevance: CrewRelevance | undefined
  /** What each party's last read showed: a change wakes only the parties it concerns. */
  private readonly partyRelevance = new Map<string, CrewRelevance>()
  /** Status wakes skipped since the host was built: a party subscribing later may show them. */
  private skipped: 'status' | undefined
  /** Dispatches whose writes were skipped since the host was built; a read that shows one rebuilds. */
  private readonly stale = new Set<string>()
  /** Shown Dispatches whose own rows changed, patched on the next read. */
  private readonly patches = new Set<string>()
  /** What the shown panes and handles resolved to at the last read. */
  private identity: string | undefined
  /** A skipped terminal record write: the next read captures the runtime's terminal records again. */
  private identitySkipped = false
  /** Each listener with the party it reads, when it said. */
  private readonly listeners = new Map<() => void, string | undefined>()
  private readonly renamed = new Set<string>()
  private readonly dirty = new Set<CrewFacet>()
  private readonly trafficAddresses = new Set<string>()
  private broadTraffic = false
  private unwatch: (() => void) | undefined

  constructor(
    private readonly readDependencies: (previous?: CrewReadDependencies) => CrewReadDependencies,
    private readonly watch: (
      wake: (facets: CrewInvalidation) => void,
      relevance: () => CrewRelevance | null
    ) => () => void
  ) {}

  private readRelevance = (): CrewRelevance | null => (this.host && this.relevance) || null

  /** Admit before any rebuild: a scoped wake about panes or dispatches no row shows changes no row. */
  private admits(facets: CrewInvalidation): boolean {
    const relevance = this.readRelevance()
    if (!relevance) {
      return true
    }
    const facetList = [...facets]
    if (facetList.every((facet) => facet === 'identity')) {
      return this.identityMoved()
    }
    if (
      (facets.paneKeys || facets.sessionIds) &&
      facetList.every((facet) => facet === 'status' || facet === 'names')
    ) {
      if (
        [...(facets.paneKeys ?? [])].some((pane) => relevance.hasPane(pane)) ||
        [...(facets.sessionIds ?? [])].some((session) => relevance.sessions.has(session))
      ) {
        return true
      }
      this.skipped ??= 'status'
      return false
    }
    if (facetList.every((facet) => facet === 'traffic')) {
      if (facets.trafficAddresses) {
        return [...facets.trafficAddresses].some((address) => relevance.addresses.has(address))
      }
      if (facets.dispatchIds) {
        return [...facets.dispatchIds].some(
          (id) => relevance.dispatches.has(id) || relevance.addresses.has(`dispatch:${id}`)
        )
      }
    }
    if (
      (facets.dispatchIds || facets.parties) &&
      facetList.every((facet) => facet === 'topology' || facet === 'assignments')
    ) {
      // A new Dispatch or Run naming a shown party or Run changes who that crew shows.
      let shown = Boolean(facets.parties && relevance.showsParty(facets.parties))
      for (const id of facets.dispatchIds ?? []) {
        if (relevance.dispatches.has(id)) {
          shown = true
          if (facets.has('assignments')) {
            this.patches.add(id)
          }
        } else if (shown) {
          continue
        } else if (this.stale.size < STALE_CAP) {
          this.stale.add(id)
        } else {
          this.dirty.add('topology')
        }
      }
      return shown
    }
    return true
  }

  /** A terminal record write changes a crew only if one of its panes or handles now resolves differently. */
  private identityMoved(): boolean {
    if (!this.host || !this.relevance || this.identity === undefined) {
      return true
    }
    try {
      const moved = crewIdentityFingerprint(this.relevance, this.host.deps) !== this.identity
      this.identitySkipped ||= !moved
      return moved
    } catch {
      // An unreadable resolution is a change: rebuild rather than keep a stale row.
      return true
    }
  }

  private invalidate = (facets: CrewInvalidation) => {
    if (!this.admits(facets)) {
      return
    }
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
      this.dirty.add(facet === 'identity' ? 'topology' : facet)
    }
    // Admitted for some crew: wake only the parties whose own rows it can change.
    for (const [listener, party] of this.listeners) {
      const relevance = party === undefined ? undefined : this.partyRelevance.get(party)
      if (!relevance || relevance.concerns(facets)) {
        listener()
      }
    }
  }

  /** `party` routes wakes: a change no row of that party shows does not wake it. */
  subscribe = (listener: () => void, party?: string): (() => void) => {
    this.listeners.set(listener, party)
    this.unwatch ??= this.watch(this.invalidate, this.readRelevance)
    // A party joining reads rows the skipped wakes may have changed; stale Dispatches it shows rebuild on read.
    if (this.skipped === 'status') {
      this.dirty.add('status').add('names')
    }
    this.skipped = undefined
    return () => {
      this.listeners.delete(listener)
      if (party !== undefined && ![...this.listeners.values()].includes(party)) {
        this.partyRelevance.delete(party)
      }
      if (this.listeners.size === 0) {
        this.unwatch?.()
        this.unwatch = undefined
        this.host = undefined
        this.relevance = undefined
        this.partyRelevance.clear()
        this.identity = undefined
        this.skipped = undefined
        this.stale.clear()
        this.patches.clear()
        this.dirty.clear()
        this.trafficAddresses.clear()
        this.broadTraffic = false
        this.renamed.clear()
      }
    }
  }

  read = (address: string): OrchestrationCrewSnapshot => {
    const snapshot = this.readOnce(address)
    // A row now showing a Dispatch whose write was skipped reads stale assignments: rebuild once.
    const shown = this.partyRelevance.get(address)
    if (this.host && shown && this.stale.size > 0) {
      for (const id of shown.dispatches) {
        if (this.stale.has(id)) {
          this.dirty.add('topology')
          return this.readOnce(address)
        }
      }
    }
    return snapshot
  }

  private rebuilt(host: CrewHostDerivation): CrewHostDerivation {
    this.stale.clear()
    return host
  }

  private readOnce(address: string): OrchestrationCrewSnapshot {
    const now = Date.now()
    const dirty = new Set(this.dirty)
    const renamed = new Set(this.renamed)
    const trafficAddresses = this.broadTraffic ? undefined : new Set(this.trafficAddresses)
    this.dirty.clear()
    this.renamed.clear()
    this.trafficAddresses.clear()
    this.broadTraffic = false
    if (this.host && this.patches.size > 0 && !dirty.has('topology') && !dirty.has('records')) {
      const patched = this.host.deps.db
        ? patchCrewAssignmentStages(
            this.host,
            readCrewAssignmentIds(this.host.deps.db, [...this.patches]),
            this.patches
          )
        : this.host
      if (patched) {
        this.host = patched
      } else {
        dirty.add('topology')
      }
    }
    this.patches.clear()
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
      this.identitySkipped = false
      if (previous && this.listeners.size && !dirty.has('records')) {
        previous.registry.refreshRecordNames(deps.records, renamed)
        deps = { ...deps, records: previous.deps.records }
      }
      // A one-shot read has no watch to keep captured truth current.
      const host = createCrewHostDerivation(deps, () => Math.max(32, this.listeners.size * 2))
      if (this.listeners.size === 0) {
        return buildCrewSnapshot(address, { ...host.deps, now }, host)
      }
      this.host = this.rebuilt(host)
      this.skipped = undefined
    } else if (dirty.has('status') || dirty.has('names')) {
      const previous = this.host
      this.host = undefined
      // After a skipped record write, rows read a fresh capture (a new peer may resolve through it).
      const deps = this.readDependencies(this.identitySkipped ? undefined : previous.deps)
      this.identitySkipped = false
      if (dirty.has('status')) {
        const { statuses, ...sources } = deps
        const relevance = this.relevance
        // Only bindings a row can show: an unrelated pane's row appearing or leaving rebuilds nothing.
        const identities = (rows: typeof statuses) => {
          const shown = new Map<string, (typeof rows)[number]['binding']>()
          for (const row of rows) {
            const { binding } = row
            if (
              !relevance ||
              relevance.panes.has(row.activity.paneKey) ||
              (binding.kind !== 'unresolved' && relevance.handles.has(binding.terminalHandle)) ||
              (binding.kind === 'worker' && relevance.dispatches.has(binding.dispatchId)) ||
              relevance.hasPane(row.activity.paneKey)
            ) {
              shown.set(row.activity.paneKey, binding)
            }
          }
          return shown
        }
        previous.registry.refreshRecordNames(deps.records, renamed)
        this.host = isDeepStrictEqual(identities(previous.deps.statuses), identities(statuses))
          ? refreshCrewStatuses(previous, statuses)
          : this.rebuilt(
              createCrewHostDerivation(
                { ...sources, records: previous.deps.records, statuses },
                () => Math.max(32, this.listeners.size * 2)
              )
            )
        if (this.skipped === 'status') {
          this.skipped = undefined
        }
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
    const shown = new CrewRelevance()
    const snapshot = buildCrewSnapshot(address, { ...this.host.deps, now }, this.host, shown)
    // A one-shot read beside the mounted ones routes nothing: only a listening party's read counts.
    if ([...this.listeners.values()].some((party) => party === address || party === undefined)) {
      this.partyRelevance.set(address, shown)
    }
    // Kept while unchanged, so the session-write scope and its worktree cache hold across wakes.
    const union = CrewRelevance.union(this.partyRelevance.values())
    if (!this.relevance?.sameAs(union)) {
      this.relevance = union
    }
    try {
      this.identity = crewIdentityFingerprint(this.relevance, this.host.deps)
    } catch {
      this.identity = undefined
    }
    return snapshot
  }
}
