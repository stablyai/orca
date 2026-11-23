// A workspace as the layout stream last sent it: its projection with live titles and start facts laid over.

import { ReverseIndexedMap } from '../../../../shared/collections/reverse-indexed-map'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/workspace-layout/layout-owner-switch'
import type { PublishedWorkspaceLayout } from '../../../../shared/workspace-layout/published-layout/workspace-layout-published'
import {
  indexPublishedLayout,
  type IndexedLayoutRecords
} from '../../../../shared/workspace-layout/published-layout/workspace-layout-records'
import { withLiveTitles } from './published-pane-live-titles'
import { paneStartFactsOf, withPaneStartFacts, type PaneFactSources } from './pane-start-statuses'
import type { ProjectedLayout } from './workspace-layout-projection'

export type ShownLayout = {
  /** The projection this was laid over; a workspace whose projection and panes are unchanged needs no recheck. */
  projected: ProjectedLayout
  liveTitles: string
  layout: PublishedWorkspaceLayout
  /** Null sends a whole layout; otherwise index records lazily on the next diff. */
  records?: IndexedLayoutRecords | null
}

export type LiveFactSources = PaneFactSources & { liveTitle: (ptyId: string) => string | null }

/** Each pane's terminal and pane key: the refs a live title or start fact changes under. A shared value only rechecks one more workspace. */
function liveRefsOf({ layout }: ProjectedLayout): string[] {
  return layout.tabs.flatMap((tab) =>
    (tab.terminal?.panes ?? []).flatMap((pane) => [
      `${tab.entityId}:${pane.leafId}`,
      ...(pane.ptyId ? [pane.ptyId] : [])
    ])
  )
}

type ShownLayouts = ReverseIndexedMap<string, ShownLayout, string>

/** Shown layouts by workspace key, resolving a changed terminal or pane key to the workspaces showing it. */
export function shownLayouts(): ShownLayouts {
  return new ReverseIndexedMap(
    (shown) => liveRefsOf(shown.projected),
    (previous, next) => previous.projected.json === next.projected.json
  )
}

function liveFactsOf(layout: PublishedWorkspaceLayout, sources: LiveFactSources) {
  const titles = layout.tabs.flatMap((tab) =>
    (tab.terminal?.panes ?? []).map((pane) => (pane.ptyId ? sources.liveTitle(pane.ptyId) : null))
  )
  // Switch point: a pane's start facts are live state, laid over as its title is.
  const starts = ORCA_LAYOUT_OWNER_IS_MAIN ? paneStartFactsOf(layout, sources) : null
  return { titles, starts }
}

function laid(
  layout: PublishedWorkspaceLayout,
  { titles, starts }: ReturnType<typeof liveFactsOf>
): PublishedWorkspaceLayout {
  const titled = withLiveTitles(layout, titles)
  return starts ? withPaneStartFacts(titled, starts) : titled
}

/** `projected` with its live state laid over; null when `previous` already shows exactly that. */
function layLiveFacts(
  projected: ProjectedLayout,
  sources: LiveFactSources,
  previous: ShownLayout | undefined
): ShownLayout | null {
  const facts = liveFactsOf(projected.layout, sources)
  const liveTitles = JSON.stringify(facts.starts ? [facts.titles, facts.starts] : facts.titles)
  if (previous?.projected.json === projected.json && previous.liveTitles === liveTitles) {
    return null
  }
  return { projected, liveTitles, layout: laid(projected.layout, facts) }
}

/**
 * Recheck the workspaces that can differ from what was shown and apply the result to `shown`:
 * those showing a changed ref, and after a reprojection those whose projected layout changed.
 */
export function updateShownLayouts(
  shown: ShownLayouts,
  next: ReadonlyMap<string, ProjectedLayout>,
  sources: LiveFactSources,
  {
    liveRefs,
    reprojected,
    recheckAll
  }: { liveRefs: ReadonlySet<string>; reprojected: boolean; recheckAll: boolean }
): { removed: string[]; changed: Map<string, { previous?: ShownLayout; current: ShownLayout }> } {
  const titled = new Set<string>()
  for (const ref of liveRefs) {
    for (const key of shown.keysFor(ref)) {
      titled.add(key)
    }
  }
  const removed: string[] = []
  const changed = new Map<string, { previous?: ShownLayout; current: ShownLayout }>()
  const recheck = (key: string, projected: ProjectedLayout): void => {
    const previous = shown.get(key)
    if (!recheckAll && !titled.has(key) && previous?.projected.json === projected.json) {
      // The same layout under a newer projection object; its panes and live state are unchanged.
      previous.projected = projected
      return
    }
    const current = layLiveFacts(projected, sources, previous)
    if (current) {
      changed.set(key, { previous, current })
    } else if (previous) {
      previous.projected = projected
    }
  }
  if (reprojected || recheckAll) {
    for (const key of shown.keys()) {
      if (!next.has(key)) {
        removed.push(key)
      }
    }
    for (const [key, projected] of next) {
      if (shown.get(key)?.projected !== projected || recheckAll || titled.has(key)) {
        recheck(key, projected)
      }
    }
  } else {
    for (const key of titled) {
      const projected = next.get(key)
      if (projected) {
        recheck(key, projected)
      }
    }
  }
  // Changes apply only once every recheck succeeded, so a failed one leaves `shown` showing what was last sent.
  for (const key of removed) {
    shown.delete(key)
  }
  for (const [key, { current }] of changed) {
    shown.set(key, current)
  }
  return { removed, changed }
}

export function laidLayout(
  layout: PublishedWorkspaceLayout,
  sources: LiveFactSources
): PublishedWorkspaceLayout {
  return laid(layout, liveFactsOf(layout, sources))
}

export function shownRecordsOf(shown: ShownLayout): IndexedLayoutRecords | null {
  if (shown.records === undefined) {
    shown.records = indexPublishedLayout(shown.layout)
  }
  return shown.records
}
