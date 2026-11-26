import { crewIdentityFingerprint, type CrewInvalidation, type CrewRelevance } from './crew-changes'
import type { CrewReadDependencies } from './crew-read-dependencies'

/** What admission records about a wake it skips, so a later read can still show what it changed. */
export type CrewWakeSkips = {
  /** Nobody listens: a terminal record write is checked by the next read, not on every notice. */
  deferIdentity: (() => void) | null
  identityMoved: () => boolean
  status: () => void
  /** A shown Dispatch whose own row changed: patched on the next read. */
  patch: (id: string) => void
  /** A Dispatch no row shows: a read that shows it later rebuilds. */
  stale: (id: string) => void
}

/** Admit before any rebuild: a scoped wake about panes or dispatches no row shows changes no row. */
export function admitCrewWake(
  facets: CrewInvalidation,
  relevance: CrewRelevance | null,
  skips: CrewWakeSkips
): boolean {
  if (!relevance) {
    return true
  }
  const facetList = [...facets]
  if (facetList.every((facet) => facet === 'identity')) {
    if (skips.deferIdentity) {
      skips.deferIdentity()
      return false
    }
    return skips.identityMoved()
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
    skips.status()
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
          skips.patch(id)
        }
      } else if (!shown) {
        skips.stale(id)
      }
    }
    return shown
  }
  return true
}

/** A terminal record write changes a crew only if one of its panes or handles now resolves differently. */
export function crewIdentityMoved(
  relevance: CrewRelevance | undefined,
  deps: CrewReadDependencies | undefined,
  identity: string | undefined
): boolean {
  if (!deps || !relevance || identity === undefined) {
    return true
  }
  try {
    return crewIdentityFingerprint(relevance, deps) !== identity
  } catch {
    // An unreadable resolution is a change: rebuild rather than keep a stale row.
    return true
  }
}
