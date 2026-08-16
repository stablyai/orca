import type { TerminalPaneLayoutNode, TerminalTab } from '../../../../shared/terminal-tab-types'
import { firstTerminalLeafId } from '../../../../shared/herdr-session-identity'
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
  restoreOrcaPaneBindings
} from './herdr-binding-metadata'
import { applyTabLayout, ensureTabSplits } from './herdr-layout-reconcile'

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
  let rootPane = findUniqueHerdrMatch(
    snapshot.panes,
    (pane) => pane.tokens?.[ORCA_BINDING_TOKEN] === rootBinding,
    `pane binding for ${rootLeafId}`
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
