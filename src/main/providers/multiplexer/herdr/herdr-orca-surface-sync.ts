import type {
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode
} from '../../../../shared/terminal-tab-types'
import type { HerdrPaneLayoutSnapshot, HerdrSessionSnapshot } from './herdr-runtime-contract'
import { orcaPaneBinding, paneBindingMapKey } from './herdr-binding-metadata'
import type { HerdrProjectHostGraph } from './herdr-runtime-graph'

export type HerdrOrcaLeafIdentity = {
  worktreeId: string
  tabId: string
  leafId: string
}

export type HerdrOrcaSurfaceAction =
  | { kind: 'rename'; tabId: string; title: string }
  | { kind: 'focus'; tabId: string; worktreeId: string; leafId: string }
  | { kind: 'close'; tabId: string }
  | { kind: 'layout'; tabId: string; layout: TerminalLayoutSnapshot }

export function resolveHerdrPaneIdentities(
  sessionName: string,
  graphs: HerdrProjectHostGraph[],
  paneIdsBySessionAndBinding: Map<string, string>
): Map<string, HerdrOrcaLeafIdentity> {
  const identities = new Map<string, HerdrOrcaLeafIdentity>()
  for (const graph of graphs) {
    for (const worktree of graph.worktrees) {
      for (const tab of graph.tabsByWorktreeId[worktree.id] ?? []) {
        const root = graph.layoutsByTabId[tab.id]?.root
        if (!root) {
          continue
        }
        for (const leafId of collectLeaves(root)) {
          const paneId = paneIdsBySessionAndBinding.get(
            paneBindingMapKey(sessionName, orcaPaneBinding(graph.project.id, leafId))
          )
          if (paneId) {
            identities.set(paneId, { worktreeId: worktree.id, tabId: tab.id, leafId })
          }
        }
      }
    }
  }
  return identities
}

export function collectHerdrSurfaceActions(
  previous: HerdrSessionSnapshot | null,
  current: HerdrSessionSnapshot,
  identities: Map<string, HerdrOrcaLeafIdentity>
): HerdrOrcaSurfaceAction[] {
  if (!previous) {
    return []
  }
  const actions: HerdrOrcaSurfaceAction[] = []
  const previousTabs = new Map(previous.tabs.map((tab) => [tab.tab_id, tab]))
  const currentTabs = new Map(current.tabs.map((tab) => [tab.tab_id, tab]))

  for (const [tabId, previousTab] of previousTabs) {
    const currentTab = currentTabs.get(tabId)
    const owner = ownerForHerdrTab(previousTab.tab_id, previous.panes, identities)
    if (!owner) {
      continue
    }
    if (!currentTab) {
      actions.push({ kind: 'close', tabId: owner.tabId })
      continue
    }
    if (previousTab.label !== currentTab.label && currentTab.label) {
      actions.push({ kind: 'rename', tabId: owner.tabId, title: currentTab.label })
    }
  }

  const previousFocus = focusedPaneId(previous)
  const currentFocus = focusedPaneId(current)
  if (currentFocus && currentFocus !== previousFocus) {
    const owner = identities.get(currentFocus)
    if (owner) {
      actions.push({
        kind: 'focus',
        tabId: owner.tabId,
        worktreeId: owner.worktreeId,
        leafId: owner.leafId
      })
    }
  }

  for (const layout of current.layouts) {
    const previousLayout = previous.layouts.find((candidate) => candidate.tab_id === layout.tab_id)
    if (!previousLayout || sameLayout(previousLayout, layout)) {
      continue
    }
    const owner = ownerForHerdrTab(layout.tab_id, current.panes, identities)
    const next = herdrLayoutToOrcaLayout(layout, identities)
    if (owner && next) {
      actions.push({ kind: 'layout', tabId: owner.tabId, layout: next })
    }
  }

  return actions
}

function collectLeaves(node: TerminalPaneLayoutNode): string[] {
  if (node.type === 'leaf') {
    return [node.leafId]
  }
  return [...collectLeaves(node.first), ...collectLeaves(node.second)]
}

function ownerForHerdrTab(
  herdrTabId: string,
  panes: { pane_id: string; tab_id: string }[],
  identities: Map<string, HerdrOrcaLeafIdentity>
): HerdrOrcaLeafIdentity | null {
  for (const pane of panes) {
    if (pane.tab_id !== herdrTabId) {
      continue
    }
    const owner = identities.get(pane.pane_id)
    if (owner) {
      return owner
    }
  }
  return null
}

function focusedPaneId(snapshot: HerdrSessionSnapshot): string | null {
  const focused = snapshot.panes.find((pane) => pane.focused)
  if (focused) {
    return focused.pane_id
  }
  for (const layout of snapshot.layouts) {
    if (layout.focused_pane_id) {
      return layout.focused_pane_id
    }
  }
  return null
}

function sameLayout(left: HerdrPaneLayoutSnapshot, right: HerdrPaneLayoutSnapshot): boolean {
  return JSON.stringify(left.splits) === JSON.stringify(right.splits)
}

export function herdrLayoutToOrcaLayout(
  layout: HerdrPaneLayoutSnapshot,
  identities: Map<string, HerdrOrcaLeafIdentity>
): TerminalLayoutSnapshot | null {
  const leaves = layout.panes
    .map((pane) => identities.get(pane.pane_id)?.leafId)
    .filter((leafId): leafId is string => Boolean(leafId))
  if (leaves.length === 0) {
    return null
  }
  if (leaves.length === 1 || !layout.splits?.[0]) {
    return {
      root: { type: 'leaf', leafId: leaves[0] },
      activeLeafId: identities.get(layout.focused_pane_id ?? '')?.leafId ?? leaves[0],
      expandedLeafId: layout.zoomed
        ? (identities.get(layout.focused_pane_id ?? '')?.leafId ?? leaves[0])
        : null
    }
  }
  const split = layout.splits[0]
  const direction = split.direction === 'down' ? 'horizontal' : 'vertical'
  const ordered = [...layout.panes].sort((a, b) =>
    direction === 'vertical' ? a.rect.x - b.rect.x : a.rect.y - b.rect.y
  )
  const first = identities.get(ordered[0]?.pane_id ?? '')?.leafId
  const second = identities.get(ordered[1]?.pane_id ?? '')?.leafId
  if (!first || !second) {
    return null
  }
  return {
    root: {
      type: 'split',
      direction,
      ratio: split.ratio,
      first: { type: 'leaf', leafId: first },
      second: { type: 'leaf', leafId: second }
    },
    activeLeafId: identities.get(layout.focused_pane_id ?? '')?.leafId ?? first,
    expandedLeafId: layout.zoomed
      ? (identities.get(layout.focused_pane_id ?? '')?.leafId ?? null)
      : null
  }
}
