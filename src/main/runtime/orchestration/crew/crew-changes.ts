import type { CrewReadDependencies } from './crew-read-dependencies'
import { parsePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'

/** `assignments`: scoped Dispatches' own rows changed (stage, liveness), not who a crew shows. */
/** `identity`: the runtime's terminal records changed somewhere; a crew rebuilds only if what its
 *  panes and handles resolve to did. */
export type CrewFacet =
  | 'topology'
  | 'assignments'
  | 'records'
  | 'status'
  | 'names'
  | 'traffic'
  | 'identity'
export type CrewInvalidation = ReadonlySet<CrewFacet> & {
  readonly recordIds?: readonly string[]
  readonly trafficAddresses?: ReadonlySet<string>
  /** A status or name change about these panes only; panes no crew row shows are skipped. */
  readonly paneKeys?: ReadonlySet<string>
  /** As `paneKeys`, for chats named by their Orca session. */
  readonly sessionIds?: ReadonlySet<string>
  /** A topology or assignments change about these dispatches only; dispatches no crew row shows are skipped. */
  readonly dispatchIds?: ReadonlySet<string>
  /** With topology: parties (session, handle or pane) a new Dispatch or Run names; a crew showing one reads it. */
  readonly parties?: ReadonlySet<string>
}

type CrewScope = Pick<CrewInvalidation, 'paneKeys' | 'sessionIds' | 'dispatchIds' | 'parties'>

/** A change about the scoped panes, chats or dispatches alone. */
export function scopedCrewChange(facets: CrewFacet[], scope: CrewScope): CrewInvalidation {
  return Object.assign(new Set(facets), scope)
}

/** A chat's status or name changed: a crew that doesn't show that chat reads nothing for it. */
export function crewChatStatusChange(sessionId: string): CrewInvalidation {
  return scopedCrewChange(['status', 'names'], { sessionIds: new Set([sessionId]) })
}

/** A hook status row added, changed or removed: a status and name change about its pane alone. */
export function crewStatusRowChange(mutation: {
  before: { paneKey: string } | null
  after: { paneKey: string } | null
}): CrewInvalidation {
  const paneKeys = new Set<string>()
  for (const row of [mutation.before, mutation.after]) {
    if (row) {
      paneKeys.add(row.paneKey)
    }
  }
  return scopedCrewChange(['status', 'names'], { paneKeys })
}

/** What the mounted crews' rows read: wakes about anything else cannot change a row. */
export class CrewRelevance {
  readonly panes = new Set<string>()
  readonly leaves = new Set<string>()
  readonly tabs = new Set<string>()
  readonly sessions = new Set<string>()
  readonly handles = new Set<string>()
  /** As `run:<id>`: Runs the rows' Dispatches belong to, and Runs a shown party coordinates. */
  readonly runs = new Set<string>()
  readonly dispatches = new Set<string>()
  /** Every address a mounted party's mail goes by: a message between other addresses is no crew's traffic. */
  readonly addresses = new Set<string>()

  /** A shown party, by every identity a new Dispatch or Run may name it by. */
  addParty(party: {
    paneKey?: string | null
    orcaSessionId?: string | null
    terminalHandle?: string | null
  }): void {
    this.addPane(party.paneKey)
    if (party.orcaSessionId) {
      this.sessions.add(party.orcaSessionId)
    }
    if (party.terminalHandle) {
      this.handles.add(party.terminalHandle)
    }
  }

  /** Whether one of these identities is a party a crew shows. */
  showsParty(parties: Iterable<string>): boolean {
    for (const party of parties) {
      if (
        this.runs.has(party) ||
        this.sessions.has(party) ||
        this.handles.has(party) ||
        this.hasPane(party)
      ) {
        return true
      }
    }
    return false
  }

  addPane(pane: string | null | undefined): void {
    if (!pane || this.panes.has(pane)) {
      return
    }
    this.panes.add(pane)
    const parsed = parsePaneKey(pane)
    const tab = parsed?.tabId ?? pane.slice(0, Math.max(0, pane.indexOf(':')))
    if (parsed) {
      this.leaves.add(parsed.leafId)
    }
    if (tab) {
      this.tabs.add(tab)
    }
  }

  /** A mounted party: its identities, every address its mail goes by, and its own Dispatches, Runs and
   *  remote attachment, which place it under its manager. */
  addSelf(
    party: Parameters<CrewRelevance['addParty']>[0],
    aliases: readonly string[],
    remoteAttachment: string | undefined
  ): void {
    this.addParty(party)
    for (const alias of aliases) {
      this.addresses.add(alias)
      if (alias.startsWith('dispatch:')) {
        this.dispatches.add(alias.slice('dispatch:'.length))
      } else if (alias.startsWith('run:')) {
        this.runs.add(alias)
      }
    }
    if (remoteAttachment) {
      this.dispatches.add(remoteAttachment)
    }
  }

  /** A shown Dispatch, and its Run, whose new Dispatches may join the same crew. */
  addAssignment(assignment: { id: string; run_id: string } | undefined): void {
    if (assignment) {
      this.dispatches.add(assignment.id)
      this.runs.add(`run:${assignment.run_id}`)
    }
  }

  /** The relevance of several parties together. */
  static union(parts: Iterable<CrewRelevance>): CrewRelevance {
    const union = new CrewRelevance()
    for (const part of parts) {
      for (const key of RELEVANCE_SETS) {
        for (const value of part[key]) {
          union[key].add(value)
        }
      }
    }
    return union
  }

  /** Whether both hold the same entries. */
  sameAs(other: CrewRelevance): boolean {
    return RELEVANCE_SETS.every(
      (key) =>
        this[key].size === other[key].size && [...this[key]].every((value) => other[key].has(value))
    )
  }

  /** Whether a change, already admitted for some crew, can change this party's rows. */
  concerns(facets: CrewInvalidation): boolean {
    const list = [...facets]
    if (
      (facets.paneKeys || facets.sessionIds) &&
      list.every((facet) => facet === 'status' || facet === 'names')
    ) {
      return (
        [...(facets.paneKeys ?? [])].some((pane) => this.hasPane(pane)) ||
        [...(facets.sessionIds ?? [])].some((session) => this.sessions.has(session))
      )
    }
    if (list.every((facet) => facet === 'traffic')) {
      if (facets.trafficAddresses) {
        return [...facets.trafficAddresses].some((address) => this.addresses.has(address))
      }
      if (facets.dispatchIds) {
        return [...facets.dispatchIds].some(
          (id) => this.dispatches.has(id) || this.addresses.has(`dispatch:${id}`)
        )
      }
    }
    if (
      (facets.dispatchIds || facets.parties) &&
      list.every((facet) => facet === 'topology' || facet === 'assignments')
    ) {
      return (
        Boolean(facets.parties && this.showsParty(facets.parties)) ||
        [...(facets.dispatchIds ?? [])].some((id) => this.dispatches.has(id))
      )
    }
    // Broad and identity changes: every crew rereads.
    return true
  }

  /** Leaf ids survive a pane's break-out, as isEquivalentPaneKey matches them. */
  hasPane(pane: string): boolean {
    if (this.panes.has(pane)) {
      return true
    }
    // `leaves` holds parsed leaf ids only, so the text after the colon matching one is the parse's own
    // answer, without parsing every fleet pane a status read checks.
    return this.leaves.size > 0 && this.leaves.has(pane.slice(pane.indexOf(':') + 1))
  }
}

/** A terminal record write: every renderer graph publish, title and layout sync makes several. */
export const TERMINAL_IDENTITY_CHANGE: CrewInvalidation = new Set(['identity'])

/** Only bindings a row can show: an unrelated pane's row appearing or leaving rebuilds nothing. */
export function crewShownBindings(
  rows: CrewReadDependencies['statuses'],
  relevance: CrewRelevance | undefined
): Map<string, CrewReadDependencies['statuses'][number]['binding']> {
  const shown = new Map<string, CrewReadDependencies['statuses'][number]['binding']>()
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

/** What a crew's panes and handles resolve to now; equal before and after a write that moved none. */
export function crewIdentityFingerprint(
  relevance: Pick<CrewRelevance, 'panes' | 'handles'>,
  resolve: Pick<
    CrewReadDependencies,
    | 'liveHandle'
    | 'handleForPane'
    | 'paneForHandle'
    | 'processForHandle'
    | 'callerPaneForHandle'
    | 'livePaneForHandle'
  >
): string {
  const facts: unknown[] = []
  for (const handle of relevance.handles) {
    facts.push(
      handle,
      resolve.liveHandle(handle),
      resolve.paneForHandle(handle),
      resolve.callerPaneForHandle?.(handle) ?? null,
      resolve.livePaneForHandle?.(handle) ?? null,
      resolve.processForHandle?.(handle) ?? null
    )
  }
  for (const pane of relevance.panes) {
    facts.push(pane, resolve.handleForPane(pane))
  }
  return JSON.stringify(facts)
}

const RELEVANCE_SETS = [
  'panes',
  'leaves',
  'tabs',
  'sessions',
  'handles',
  'runs',
  'dispatches',
  'addresses'
] as const satisfies readonly (keyof CrewRelevance)[]

/** Invalidation is synchronous; the existing stream scheduler reads only after the commit. */
export class CrewChanges {
  private readonly listeners = new Set<(facets: CrewInvalidation) => void>()

  subscribe = (listener: (facets: CrewInvalidation) => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  hasListeners = (): boolean => this.listeners.size > 0

  notify = (facets: CrewInvalidation = new Set(['topology'])): void => {
    for (const listener of this.listeners) {
      listener(facets)
    }
  }
}

export const sessionCrewChanges = new CrewChanges()
