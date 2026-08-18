import type { Project } from '../../../../shared/project-types'
import { ORCA_METADATA_SOURCE, orcaPaneBinding, paneBindingMapKey } from './herdr-binding-metadata'
import { findHerdrWorkspaceForWorktree, type HerdrProjectHostGraph } from './ensure-herdr-workspace'
import { collectHerdrPaneIds } from './herdr-tab-layout'
import type { HerdrHostTransport, HerdrSessionSnapshot } from './herdr-runtime-contract'
import { unwrapHerdrResponse } from './herdr-runtime-contract'
import type { LayoutNode } from './herdr-socket-types'

export async function materializeHerdrLeafPane(args: {
  transport: HerdrHostTransport
  sessionName: string
  project: Project
  leafId: string
  cwd: string
  worktree: { id: string; path: string; displayName?: string }
  graph: HerdrProjectHostGraph | undefined
  paneIdsBySessionAndBinding: Map<string, string>
  snapshot: () => Promise<HerdrSessionSnapshot>
}): Promise<string | null> {
  const snapshot = await args.snapshot()
  const worktree =
    args.graph?.worktrees.find((candidate) => candidate.id === args.worktree.id) ?? args.worktree
  const workspace = findHerdrWorkspaceForWorktree(snapshot, args.project.id, worktree)
  const claimedPaneIds = new Set(args.paneIdsBySessionAndBinding.values())
  const workspacePanes = snapshot.panes.filter(
    (pane) => workspace && pane.workspace_id === workspace.workspace_id
  )
  const reusable =
    workspacePanes.find((pane) => !claimedPaneIds.has(pane.pane_id)) ??
    (workspacePanes.length === 1 ? workspacePanes[0] : undefined)
  if (reusable) {
    return claimMaterializedPane(args, reusable.pane_id)
  }
  if (!workspace) {
    return null
  }
  const applied = unwrapHerdrResponse<{
    layout: { root?: LayoutNode }
    workspace_id: string
    tab_id: string
  }>(
    await args.transport.request(args.sessionName, 'layout.apply', {
      workspace_id: workspace.workspace_id,
      tab_label: 'Terminal',
      root: { type: 'pane', pane_id: args.leafId, cwd: args.cwd },
      focus: false
    })
  )
  const paneIds: string[] = []
  collectHerdrPaneIds(applied.layout?.root, paneIds)
  const paneId = paneIds[0]
  if (!paneId) {
    return null
  }
  return claimMaterializedPane(args, paneId)
}

async function claimMaterializedPane(
  args: {
    transport: HerdrHostTransport
    sessionName: string
    project: Project
    leafId: string
    paneIdsBySessionAndBinding: Map<string, string>
  },
  paneId: string
): Promise<string> {
  await args.transport.request(args.sessionName, 'pane.report_metadata', {
    pane_id: paneId,
    source: ORCA_METADATA_SOURCE,
    tokens: { orca_binding: orcaPaneBinding(args.project.id, args.leafId) }
  })
  args.paneIdsBySessionAndBinding.set(
    paneBindingMapKey(args.sessionName, orcaPaneBinding(args.project.id, args.leafId)),
    paneId
  )
  return paneId
}
