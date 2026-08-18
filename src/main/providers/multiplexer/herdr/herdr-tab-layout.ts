import type { TerminalPaneLayoutNode, TerminalTab } from '../../../../shared/terminal-tab-types'
import { firstTerminalLeafId, herdrSplitDirection } from '../../../../shared/herdr-session-identity'
import type {
  HerdrHostTransport,
  HerdrPane,
  HerdrSessionSnapshot,
  HerdrTab
} from './herdr-runtime-contract'
import { HerdrRuntimeError, unwrapHerdrResponse } from './herdr-runtime-contract'
import {
  claimOrcaPaneBinding,
  collectLeafIds,
  findUniqueHerdrMatch,
  ORCA_BINDING_TOKEN,
  ORCA_METADATA_SOURCE,
  orcaPaneBinding,
  reclaimExclusiveOrcaPaneBinding,
  restoreOrcaPaneBindings
} from './herdr-binding-metadata'
import type { LayoutApplyResult, LayoutNode } from './herdr-socket-types'

function hintedSplitIsLive(
  root: TerminalPaneLayoutNode,
  workspaceId: string,
  snapshot: HerdrSessionSnapshot,
  persistedPaneIds: Record<string, string>
): boolean {
  return collectLeafIds(root).every((leafId) => {
    const paneId = persistedPaneIds[leafId]
    return Boolean(
      paneId &&
      snapshot.panes.some((pane) => pane.pane_id === paneId && pane.workspace_id === workspaceId)
    )
  })
}

// Ensure the tab layout exists in herdr, either via layout.apply or pane.split replay.
// Returns void; throws on unrecoverable errors.
export async function ensureTabLayout(
  transport: HerdrHostTransport,
  sessionName: string,
  projectId: string,
  workspaceId: string,
  tab: TerminalTab,
  root: TerminalPaneLayoutNode,
  snapshot: HerdrSessionSnapshot,
  persistedPaneIds: Record<string, string>
): Promise<void> {
  const rootLeafId = firstTerminalLeafId(root)
  if (!rootLeafId) {
    return
  }
  const rootBinding = orcaPaneBinding(projectId, rootLeafId)
  let rootPane = await reclaimExclusiveOrcaPaneBinding(
    transport,
    sessionName,
    snapshot,
    rootBinding,
    {
      preferredPaneId: persistedPaneIds[rootLeafId],
      workspaceId
    }
  )
  const hintedPane = collectLeafIds(root)
    .map((leafId) => persistedPaneIds[leafId])
    .filter((paneId): paneId is string => Boolean(paneId))
    .map((paneId) => snapshot.panes.find((pane) => pane.pane_id === paneId))
    .find((pane) => pane?.workspace_id === workspaceId)
  let herdrTab = rootPane
    ? snapshot.tabs.find((candidate) => candidate.tab_id === rootPane?.tab_id)
    : snapshot.tabs.find((candidate) => candidate.tab_id === hintedPane?.tab_id)

  if (!herdrTab) {
    const expectedLabel = tab.customTitle ?? tab.title
    herdrTab =
      findUniqueHerdrMatch(
        snapshot.tabs,
        (candidate) => candidate.workspace_id === workspaceId && candidate.label === expectedLabel,
        `tab label ${expectedLabel}`
      ) ?? undefined
    if (herdrTab) {
      const untaggedPanes = snapshot.panes.filter(
        (pane) => pane.tab_id === herdrTab?.tab_id && !pane.tokens?.[ORCA_BINDING_TOKEN]
      )
      rootPane = untaggedPanes.length === 1 ? untaggedPanes[0] : null
    }
  }

  // Why: materializeLeafPane used to leave one tab labeled leaf-<id>. Orca
  // persists title "1", so label match fails and tab.create would duplicate.
  if (!herdrTab) {
    const workspaceTabs = snapshot.tabs.filter(
      (candidate) => candidate.workspace_id === workspaceId
    )
    if (workspaceTabs.length === 1) {
      herdrTab = workspaceTabs[0]
    }
  }

  if (herdrTab && !rootPane) {
    await restoreOrcaPaneBindings(
      transport,
      sessionName,
      projectId,
      root,
      herdrTab.tab_id,
      snapshot,
      persistedPaneIds
    )
    rootPane =
      snapshot.panes.find((pane) => pane.tokens?.[ORCA_BINDING_TOKEN] === rootBinding) ?? null
  }

  if (herdrTab && !rootPane) {
    // Why: a tab whose panes all carry stale leaf tokens from earlier runs has
    // no untagged pane to adopt. Reclaim the tab's first pane and move the
    // binding to it; the daemon enforces single-owner tokens so the stale
    // holder drops the key.
    const tabPane = snapshot.panes.find((pane) => pane.tab_id === herdrTab?.tab_id)
    if (tabPane) {
      await transport.request(sessionName, 'pane.report_metadata', {
        pane_id: tabPane.pane_id,
        source: ORCA_METADATA_SOURCE,
        tokens: { [ORCA_BINDING_TOKEN]: rootBinding }
      })
      for (const pane of snapshot.panes) {
        if (pane.pane_id !== tabPane.pane_id && pane.tokens?.[ORCA_BINDING_TOKEN]) {
          delete pane.tokens[ORCA_BINDING_TOKEN]
        }
      }
      tabPane.tokens = { ...tabPane.tokens, [ORCA_BINDING_TOKEN]: rootBinding }
      rootPane = tabPane
    }
  }

  if (!herdrTab) {
    const created = unwrapHerdrResponse<{ tab: HerdrTab; root_pane: HerdrPane }>(
      await transport.request(sessionName, 'tab.create', {
        workspace_id: workspaceId,
        cwd: tab.startupCwd,
        label: tab.customTitle ?? tab.title,
        focus: false
      })
    )
    herdrTab = created.tab
    rootPane = created.root_pane
    snapshot.tabs.push(created.tab)
    snapshot.panes.push(created.root_pane)
  }

  if (!rootPane) {
    throw new HerdrRuntimeError(
      'herdr_binding_ambiguous',
      `Cannot identify a root pane for stock Herdr tab ${herdrTab.tab_id}`
    )
  }
  if (rootPane.tokens?.[ORCA_BINDING_TOKEN] !== rootBinding) {
    await claimOrcaPaneBinding(transport, sessionName, projectId, rootLeafId, rootPane, snapshot)
  }
  if (root.type === 'leaf') {
    return
  }
  // Why: after `session stop` Herdr restores pane ids but drops tokens.
  // layout.apply rematerializes the split and mints new pane ids.
  if (hintedSplitIsLive(root, workspaceId, snapshot, persistedPaneIds)) {
    await restoreOrcaPaneBindings(
      transport,
      sessionName,
      projectId,
      root,
      herdrTab.tab_id,
      snapshot,
      persistedPaneIds
    )
    return
  }
  // Prefer one layout.apply to materialize the whole tree; fall
  // back to pane.split replay when the server cannot apply it.
  const applied = await applyTabLayout(
    transport,
    sessionName,
    projectId,
    workspaceId,
    tab,
    root,
    snapshot
  )
  if (!applied) {
    await ensureTabSplits(transport, sessionName, projectId, root, rootPane.pane_id, snapshot)
  }
}

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
