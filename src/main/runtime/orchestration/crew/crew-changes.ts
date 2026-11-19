import { parsePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'

export type CrewFacet = 'topology' | 'records' | 'status' | 'names' | 'traffic'
export type CrewInvalidation = ReadonlySet<CrewFacet> & {
  readonly recordIds?: readonly string[]
  readonly trafficAddresses?: ReadonlySet<string>
  /** A status or name change about these panes only; panes no crew row shows are skipped. */
  readonly paneKeys?: ReadonlySet<string>
  /** As `paneKeys`, for chats named by their Orca session. */
  readonly sessionIds?: ReadonlySet<string>
  /** A topology change about these dispatches only; dispatches no crew row shows are skipped. */
  readonly dispatchIds?: ReadonlySet<string>
}

type CrewScope = Pick<CrewInvalidation, 'paneKeys' | 'sessionIds' | 'dispatchIds'>

/** A change about the scoped panes, chats or dispatches alone. */
export function scopedCrewChange(facets: CrewFacet[], scope: CrewScope): CrewInvalidation {
  return Object.assign(new Set(facets), scope)
}

/** What the mounted crews' rows read: wakes about anything else cannot change a row. */
export class CrewRelevance {
  readonly panes = new Set<string>()
  readonly leaves = new Set<string>()
  readonly tabs = new Set<string>()
  readonly sessions = new Set<string>()
  readonly dispatches = new Set<string>()

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

  /** Leaf ids survive a pane's break-out, as isEquivalentPaneKey matches them. */
  hasPane(pane: string): boolean {
    if (this.panes.has(pane)) {
      return true
    }
    const leaf = parsePaneKey(pane)?.leafId
    return Boolean(leaf && this.leaves.has(leaf))
  }
}

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
