import type { TerminalPaneLayoutNode } from '../../../../shared/terminal-tab-types'
import { firstTerminalLeafId, herdrSplitDirection } from '../../../../shared/herdr-session-identity'
import type { HerdrHostTransport, HerdrPane, HerdrSessionSnapshot } from './herdr-runtime-contract'
import { unwrapHerdrResponse } from './herdr-runtime-contract'
import type { LayoutApplyResult, LayoutNode } from './herdr-socket-types'
import {
  claimOrcaPaneBinding,
  collectLeafIds,
  orcaPaneBinding,
  reclaimExclusiveOrcaPaneBinding
} from './herdr-binding-metadata'

// Convert an Orca terminal layout tree into a herdr LayoutNode. Leaves are
// bare panes; herdr inherits the tab cwd. direction vertical -> right.
export function terminalLayoutToHerdrLayout(node: TerminalPaneLayoutNode): LayoutNode {
  if (node.type === 'leaf') {
    return { type: 'pane' }
  }
  return {
    type: 'split',
    direction: herdrSplitDirection(node.direction),
    ratio: node.ratio ?? 0.5,
    first: terminalLayoutToHerdrLayout(node.first),
    second: terminalLayoutToHerdrLayout(node.second)
  }
}

export function collectHerdrPaneIds(node: LayoutNode | undefined, out: string[]): void {
  if (!node) {
    return
  }
  if (node.type === 'pane') {
    if (node.pane_id) {
      out.push(node.pane_id)
    }
    return
  }
  collectHerdrPaneIds(node.first, out)
  collectHerdrPaneIds(node.second, out)
}

// Materialize a fresh tab layout with one layout.apply call. Returns the
// leafId -> pane_id bindings, or null when the transport/server cannot apply
// the layout (caller falls back to pane.split replay).
export async function applyTabLayout(
  transport: HerdrHostTransport,
  sessionName: string,
  projectId: string,
  workspaceId: string,
  tab: { startupCwd?: string; customTitle?: string | null; title: string },
  root: TerminalPaneLayoutNode,
  snapshot: HerdrSessionSnapshot
): Promise<Map<string, string> | null> {
  let applied: LayoutApplyResult
  try {
    applied = unwrapHerdrResponse<LayoutApplyResult & { root?: LayoutNode }>(
      await transport.request(sessionName, 'layout.apply', {
        workspace_id: workspaceId,
        root: terminalLayoutToHerdrLayout(root),
        tab_label: tab.customTitle ?? tab.title,
        focus: false
      })
    )
  } catch {
    return null
  }
  const layout = (applied as { layout?: { root?: LayoutNode; tab_id?: string } }).layout
  const layoutRoot = layout?.root
  const leafIds = collectLeafIds(root)
  const paneIds: string[] = []
  collectHerdrPaneIds(layoutRoot, paneIds)
  if (leafIds.length !== paneIds.length) {
    return null
  }
  const tabId = layout?.tab_id ?? ''
  const bindings = new Map<string, string>()
  for (let i = 0; i < leafIds.length; i++) {
    const leafId = leafIds[i]
    const paneId = paneIds[i]
    bindings.set(leafId, paneId)
    const existing = snapshot.panes.find((candidate) => candidate.pane_id === paneId)
    const pane =
      existing ?? ({ pane_id: paneId, tab_id: tabId, workspace_id: workspaceId } as HerdrPane)
    await claimOrcaPaneBinding(transport, sessionName, projectId, leafId, pane, snapshot)
    if (!existing) {
      snapshot.panes.push(pane)
    }
  }
  return bindings
}

// pane.split replay: the deterministic fallback when layout.apply is
// unavailable. Preserves the exact Orca split tree via recursive splits.
export async function ensureTabSplits(
  transport: HerdrHostTransport,
  sessionName: string,
  projectId: string,
  node: TerminalPaneLayoutNode,
  firstPaneId: string,
  snapshot: HerdrSessionSnapshot
): Promise<void> {
  if (node.type === 'leaf') {
    return
  }
  const secondLeafId = firstTerminalLeafId(node.second)
  if (!secondLeafId) {
    return
  }
  const binding = orcaPaneBinding(projectId, secondLeafId)
  let secondPane = await reclaimExclusiveOrcaPaneBinding(transport, sessionName, snapshot, binding)
  if (!secondPane) {
    secondPane = unwrapHerdrResponse<{ pane: HerdrPane }>(
      await transport.request(sessionName, 'pane.split', {
        target_pane_id: firstPaneId,
        direction: herdrSplitDirection(node.direction),
        ratio: node.ratio ?? 0.5,
        focus: false
      })
    ).pane
    await claimOrcaPaneBinding(
      transport,
      sessionName,
      projectId,
      secondLeafId,
      secondPane,
      snapshot
    )
    snapshot.panes.push(secondPane)
  }
  await ensureTabSplits(transport, sessionName, projectId, node.first, firstPaneId, snapshot)
  await ensureTabSplits(
    transport,
    sessionName,
    projectId,
    node.second,
    secondPane.pane_id,
    snapshot
  )
}
