import { isDeepStrictEqual } from 'node:util'
import {
  CrewRelevance,
  crewIdentityFingerprint,
  crewShownBindings,
  type CrewFacet,
  type CrewInvalidation
} from './crew-changes'
import { buildCrewSnapshot } from './crew-party-snapshot'
import { admitCrewWake, crewIdentityMoved, type CrewWakeSkips } from './crew-wake-admission'
import type { CrewReadDependencies } from './crew-read-dependencies'
import type { OrchestrationCrewSnapshot } from '../../../../shared/orchestration/orchestration-crew'
import {
  patchCrewAssignmentStages,
  refreshCrewStatuses,
  type CrewHostDerivation
} from './crew-host-derivation'
import {
  crewRebuildTrigger,
  crewHostBuilder,
  type CrewRebuildTrigger
} from './crew-host-rebuild-trace'

/** One host derivation is shared by all mounted parties; it is released a grace period after the last subscriber leaves. */
/** Past this many skipped Dispatches the next read rebuilds instead of tracking more. */
const STALE_CAP = 4096
/** How long the host outlives its last listener, so a hide/show or reconnect reuses it. */
export const CREW_HOST_GRACE_MS = 30_000

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
  private unwatch: ((() => void) & { resume?: () => void }) | undefined
  private release: ReturnType<typeof setTimeout> | undefined
  /** Why a subscribe forced the next rebuild, for its trace. */
  private forced: CrewRebuildTrigger | undefined
  /** Parties whose last listener left since the last subscribe: their rows still filter wakes, so their return reads fresh. */
  private readonly departed = new Set<string>()
  /** A terminal record write while nobody listened, checked by the next read instead of on every notice. */
  private identityDeferred = false
  private readonly hosts = crewHostBuilder(() => this.listeners.size)

  constructor(
    private readonly readDependencies: (previous?: CrewReadDependencies) => CrewReadDependencies,
    private readonly watch: (
      wake: (facets: CrewInvalidation) => void,
      relevance: () => CrewRelevance | null,
      /** Nobody listens: a source may note changes and compare them on `resume`, before the next read. */
      idle: () => boolean
    ) => (() => void) & { resume?: () => void }
  ) {}

  private readRelevance = (): CrewRelevance | null => (this.host && this.relevance) || null

  private readonly skips: CrewWakeSkips = {
    deferIdentity: null,
    identityMoved: () => this.identityMoved(),
    status: () => {
      this.skipped ??= 'status'
    },
    patch: (id) => this.patches.add(id),
    stale: (id) => (this.stale.size < STALE_CAP ? this.stale.add(id) : this.dirty.add('topology'))
  }

  private admits(facets: CrewInvalidation): boolean {
    this.skips.deferIdentity =
      this.listeners.size === 0 ? () => (this.identityDeferred = true) : null
    return admitCrewWake(facets, this.readRelevance(), this.skips)
  }

  /** A terminal record write changes a crew only if one of its panes or handles now resolves differently. */
  private identityMoved(): boolean {
    const moved = crewIdentityMoved(this.relevance, this.host?.deps, this.identity)
    this.identitySkipped ||= !moved
    return moved
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
    // Kept past a hide only for the parties whose rows filtered wakes since: anyone else reads as after a release.
    if (
      this.listeners.size === 0 &&
      this.host &&
      (party === undefined || !this.departed.has(party))
    ) {
      this.dirty.add('topology')
      this.forced = 'first-subscribe'
    }
    for (const left of this.departed) {
      if (left !== party) {
        this.partyRelevance.delete(left)
      }
    }
    this.departed.clear()
    this.listeners.set(listener, party)
    clearTimeout(this.release)
    this.release = undefined
    this.unwatch ??= this.watch(
      this.invalidate,
      this.readRelevance,
      () => this.listeners.size === 0
    )
    // A party joining reads rows the skipped wakes may have changed; stale Dispatches it shows rebuild on read.
    this.applySkippedStatus()
    return () => {
      if (!this.listeners.delete(listener)) {
        return
      }
      if (party !== undefined && ![...this.listeners.values()].includes(party)) {
        // Only the last party to leave is kept for: beside other listeners its rows stop filtering wakes.
        if (this.listeners.size === 0) {
          this.departed.add(party)
        } else {
          this.partyRelevance.delete(party)
        }
      }
      if (this.listeners.size === 0) {
        // The watch stays for the grace period, so the kept host sees every change; then nothing runs.
        this.release = setTimeout(this.releaseHost, CREW_HOST_GRACE_MS)
        this.release.unref?.()
      }
    }
  }

  private applySkippedStatus(): void {
    if (this.skipped === 'status') {
      this.dirty.add('status').add('names')
    }
    this.skipped = undefined
  }

  private releaseHost = () => {
    this.release = undefined
    if (this.listeners.size > 0) {
      return
    }
    this.unwatch?.()
    this.unwatch = this.host = this.relevance = this.identity = this.skipped = undefined
    this.broadTraffic = false
    for (const kept of [this.partyRelevance, this.departed, this.stale, this.patches, this.dirty]) {
      kept.clear()
    }
    this.identityDeferred = false
    this.forced = undefined
    this.trafficAddresses.clear()
    this.renamed.clear()
  }

  read = (address: string): OrchestrationCrewSnapshot => {
    try {
      // Unwatched, or kept for parties this one is not: a one-shot read has no watch keeping its rows current.
      if (this.listeners.size === 0 && !this.departed.has(address)) {
        const host = this.hosts.build('one-shot', this.readDependencies())
        return buildCrewSnapshot(address, { ...host.deps, now: Date.now() }, host)
      }
      this.unwatch?.resume?.()
      // A read kept for the party that left shows peers its rows did not: apply status wakes skipped since.
      if (this.listeners.size === 0) {
        this.applySkippedStatus()
      }
      return this.readFresh(address)
    } finally {
      this.hosts.settle()
    }
  }

  private readFresh(address: string): OrchestrationCrewSnapshot {
    const snapshot = this.readOnce(address)
    // A row now showing a Dispatch whose write was skipped reads stale assignments: rebuild once.
    const shown = this.partyRelevance.get(address)
    if (this.host && shown && this.stale.size > 0) {
      for (const id of shown.dispatches) {
        if (this.stale.has(id)) {
          this.dirty.add('topology')
          return this.readOnce(address, 'stale-dispatch')
        }
      }
    }
    return snapshot
  }

  /** A fresh host: nothing skipped yet, and parties that left read as new when they return. */
  private rebuilt(host: CrewHostDerivation): CrewHostDerivation {
    this.stale.clear()
    for (const party of this.departed) {
      this.partyRelevance.delete(party)
    }
    this.departed.clear()
    return host
  }

  private readOnce(address: string, cause?: CrewRebuildTrigger): OrchestrationCrewSnapshot {
    if (this.identityDeferred) {
      this.identityDeferred = false
      if (this.identityMoved()) {
        // The deferred notices' record ids were not kept: capture records fresh.
        this.dirty.add('topology').add('records')
      }
    }
    const now = Date.now()
    const dirty = new Set(this.dirty)
    const renamed = new Set(this.renamed)
    const trafficAddresses = this.broadTraffic ? undefined : new Set(this.trafficAddresses)
    this.dirty.clear()
    this.renamed.clear()
    this.trafficAddresses.clear()
    this.broadTraffic = false
    if (this.host && this.patches.size > 0 && !dirty.has('topology') && !dirty.has('records')) {
      const patched = patchCrewAssignmentStages(this.host, this.patches)
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
      if (previous && this.listeners.size && !dirty.has('records') && !this.forced) {
        previous.registry.refreshRecordNames(deps.records, renamed)
        deps = { ...deps, records: previous.deps.records }
      }
      // A one-shot read has no watch to keep captured truth current.
      const host = this.hosts.build(
        crewRebuildTrigger(previous, this.listeners.size > 0, dirty, now, cause ?? this.forced),
        deps
      )
      this.forced = undefined
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
        previous.registry.refreshRecordNames(deps.records, renamed)
        this.host = isDeepStrictEqual(
          crewShownBindings(previous.deps.statuses, relevance),
          crewShownBindings(statuses, relevance)
        )
          ? refreshCrewStatuses(previous, statuses)
          : this.rebuilt(
              this.hosts.build('status-identity', {
                ...sources,
                records: previous.deps.records,
                statuses
              })
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
