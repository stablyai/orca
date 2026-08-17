import { randomUUID } from 'node:crypto'
import { encodeHerdrPtyId } from './herdr-pty-codec'
import type { HerdrProjectHostGraph } from './herdr-runtime-graph'
import type { HerdrPane, HerdrSessionSnapshot, HerdrTab } from './herdr-runtime-contract'
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
