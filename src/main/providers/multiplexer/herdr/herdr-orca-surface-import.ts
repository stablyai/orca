import { randomUUID } from 'node:crypto'
import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'
import type { HerdrProjectHostGraph } from './ensure-herdr-workspace'
import { encodeHerdrPtyId } from './herdr-pty-types'
import type {
  HerdrPane,
  HerdrPaneLayoutSnapshot,
  HerdrSessionSnapshot,
  HerdrTab
} from './herdr-runtime-contract'
import {
  ORCA_BINDING_TOKEN,
  ORCA_METADATA_SOURCE,
  collectLeafIds,
  orcaPaneBinding,
  orcaWorkspaceBinding,
  paneBindingMapKey
} from './herdr-binding-metadata'
import type { HerdrHostTransport } from './herdr-runtime-contract'
import { unwrapHerdrResponse } from './herdr-runtime-contract'

export type HerdrImportedSurface = {
  worktreeId: string
  tabId: string
  leafId: string
  paneId: string
  ptyId: string
  title?: string
  cwd?: string
  splitFromLeafId?: string
  splitDirection?: 'vertical' | 'horizontal'
}

export type HerdrSurfacePresenter = (surface: HerdrImportedSurface) => void

export function collectUnboundHerdrSurfaces(
  sessionName: string,
  graph: HerdrProjectHostGraph,
  snapshot: HerdrSessionSnapshot,
  paneIdsBySessionAndBinding: Map<string, string>
): HerdrImportedSurface[] {
  const imported: HerdrImportedSurface[] = []
  for (const worktree of graph.worktrees) {
    const workspaceBinding = orcaWorkspaceBinding(graph.project.id, worktree)
    const workspace = snapshot.workspaces.find(
      (candidate) => candidate.tokens?.[ORCA_BINDING_TOKEN] === workspaceBinding
    )
    if (!workspace) {
      continue
    }
    const tabs = snapshot.tabs.filter((tab) => tab.workspace_id === workspace.workspace_id)
    for (const tab of tabs) {
      imported.push(
        ...collectUnboundTabSurfaces(
          sessionName,
          graph,
          worktree.id,
          tab,
          snapshot,
          paneIdsBySessionAndBinding
        )
      )
    }
  }
  return imported
}

function collectUnboundTabSurfaces(
  sessionName: string,
  graph: HerdrProjectHostGraph,
  worktreeId: string,
  tab: HerdrTab,
  snapshot: HerdrSessionSnapshot,
  paneIdsBySessionAndBinding: Map<string, string>
): HerdrImportedSurface[] {
  const panes = snapshot.panes.filter((pane) => pane.tab_id === tab.tab_id)
  const unbound = panes.filter((pane) => !pane.tokens?.[ORCA_BINDING_TOKEN])
  const owner = findOrcaOwnerForHerdrTab(
    sessionName,
    graph,
    worktreeId,
    panes,
    paneIdsBySessionAndBinding
  )
  if (!owner && (graph.tabsByWorktreeId[worktreeId] ?? []).length > 0) {
    const herdrTabsInWorkspace = snapshot.tabs.filter(
      (candidate) => candidate.workspace_id === tab.workspace_id
    )
    if (herdrTabsInWorkspace.length <= 1 || isOrcaProvisionedHerdrTabLabel(tab.label)) {
      return []
    }
  }
  if (!owner) {
    const root = unbound[0] ?? panes[0]
    if (!root) {
      return []
    }
    const leafId = randomUUID()
    const tabId = randomUUID()
    return [
      surfaceFor(graph, worktreeId, tabId, leafId, root, tab.label, undefined, snapshot, tab.tab_id)
    ]
  }
  if (unbound.length === 0) {
    return []
  }
  return unbound.map((pane) => {
    const leafId = randomUUID()
    return surfaceFor(
      graph,
      worktreeId,
      owner.tabId,
      leafId,
      pane,
      tab.label,
      owner.leafId,
      snapshot,
      tab.tab_id
    )
  })
}

function isOrcaProvisionedHerdrTabLabel(label: string | undefined): boolean {
  if (!label) {
    return false
  }
  // Why: workspace.create names the first tab "1"; materialize used "Terminal"
  // or leaf-<id>. Those are Orca leftovers, not extra Herdr tabs.
  return label === '1' || label === 'Terminal' || /^leaf-[0-9a-f-]{8,}$/i.test(label)
}

function findOrcaOwnerForHerdrTab(
  sessionName: string,
  graph: HerdrProjectHostGraph,
  worktreeId: string,
  panes: HerdrPane[],
  paneIdsBySessionAndBinding: Map<string, string>
): { tabId: string; leafId: string } | null {
  const paneIds = new Set(panes.map((pane) => pane.pane_id))
  for (const tab of graph.tabsByWorktreeId[worktreeId] ?? []) {
    const root = graph.layoutsByTabId[tab.id]?.root
    const leafIds = root ? collectLeafIds(root) : []
    for (const leafId of leafIds) {
      const paneId = paneIdsBySessionAndBinding.get(
        paneBindingMapKey(sessionName, orcaPaneBinding(graph.project.id, leafId))
      )
      if (paneId && paneIds.has(paneId)) {
        return { tabId: tab.id, leafId }
      }
    }
  }
  return null
}

function surfaceFor(
  graph: HerdrProjectHostGraph,
  worktreeId: string,
  tabId: string,
  leafId: string,
  pane: HerdrPane,
  title: string | undefined,
  splitFromLeafId: string | undefined,
  snapshot: HerdrSessionSnapshot,
  herdrTabId: string
): HerdrImportedSurface {
  const ptyId = encodeHerdrPtyId({
    version: 2,
    hostId: 'local',
    projectId: graph.project.id,
    worktreeId,
    tabId,
    leafId,
    paneId: pane.pane_id
  })
  return {
    worktreeId,
    tabId,
    leafId,
    paneId: pane.pane_id,
    ptyId,
    title,
    cwd: pane.cwd ?? pane.foreground_cwd,
    ...(splitFromLeafId
      ? {
          splitFromLeafId,
          splitDirection: splitDirectionFor(snapshot, herdrTabId)
        }
      : {})
  }
}

function splitDirectionFor(
  snapshot: HerdrSessionSnapshot,
  tabId: string
): 'vertical' | 'horizontal' {
  const layout = snapshot.layouts.find((candidate) => candidate.tab_id === tabId)
  const split = layout?.splits?.[0]
  if (split && 'direction' in split && split.direction === 'down') {
    return 'horizontal'
  }
  return 'vertical'
}

export async function claimAndPresentHerdrSurfaces(
  transport: HerdrHostTransport,
  sessionName: string,
  projectId: string,
  snapshot: HerdrSessionSnapshot,
  surfaces: HerdrImportedSurface[],
  persist: (surface: HerdrImportedSurface) => void,
  present?: HerdrSurfacePresenter
): Promise<void> {
  for (const surface of surfaces) {
    const binding = orcaPaneBinding(projectId, surface.leafId)
    unwrapHerdrResponse(
      await transport.request(sessionName, 'pane.report_metadata', {
        pane_id: surface.paneId,
        source: ORCA_METADATA_SOURCE,
        tokens: { [ORCA_BINDING_TOKEN]: binding }
      })
    )
    const pane = snapshot.panes.find((candidate) => candidate.pane_id === surface.paneId)
    if (pane) {
      pane.tokens = { ...pane.tokens, [ORCA_BINDING_TOKEN]: binding }
    }
    persist(surface)
    present?.(surface)
  }
}

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
        for (const leafId of collectLeafIds(root)) {
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
