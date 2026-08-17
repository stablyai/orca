import { firstTerminalLeafId } from '../../../../shared/herdr-session-identity'
import type { TerminalPaneLayoutNode, TerminalTab } from '../../../../shared/terminal-tab-types'
import { basename } from 'node:path'
import {
  findUniqueHerdrMatch,
  ORCA_BINDING_TOKEN,
  ORCA_METADATA_SOURCE,
  orcaPaneBinding,
  orcaWorkspaceBinding,
  reportOrcaWorkspaceBinding
} from './herdr-binding-metadata'
import { isLinkedHerdrWorktree, type HerdrWorktreeDescriptor } from './herdr-worktree-descriptor'
import type {
  HerdrHostTransport,
  HerdrPane,
  HerdrSessionSnapshot,
  HerdrTab,
  HerdrWorkspace
} from './herdr-runtime-contract'
import { HerdrRuntimeError, unwrapHerdrResponse } from './herdr-runtime-contract'

type OpenedStockWorktree = {
  workspace: HerdrWorkspace
  tab: HerdrTab
  root_pane: HerdrPane
  already_open: boolean
}

export async function ensureStockHerdrWorkspace(
  transport: HerdrHostTransport,
  sessionName: string,
  projectId: string,
  worktree: HerdrWorktreeDescriptor,
  firstTab: TerminalTab | undefined,
  firstRoot: TerminalPaneLayoutNode | null,
  snapshot: HerdrSessionSnapshot
): Promise<HerdrWorkspace> {
  const binding = orcaWorkspaceBinding(projectId, worktree)
  const bound = findUniqueHerdrMatch(
    snapshot.workspaces,
    (workspace) => workspace.tokens?.[ORCA_BINDING_TOKEN] === binding,
    'workspace binding'
  )
  if (bound) {
    return bound
  }

  const adoptable = findUniqueHerdrMatch(
    snapshot.workspaces,
    (workspace) =>
      !workspace.tokens?.[ORCA_BINDING_TOKEN] &&
      workspace.worktree?.checkout_path === worktree.path,
    `workspace checkout ${worktree.path}`
  )
  if (adoptable) {
    await reportOrcaWorkspaceBinding(transport, sessionName, adoptable.workspace_id, binding)
    adoptable.tokens = { ...adoptable.tokens, [ORCA_BINDING_TOKEN]: binding }
    return adoptable
  }

  if (isLinkedHerdrWorktree(worktree)) {
    const opened = await openStockWorktree(
      transport,
      sessionName,
      projectId,
      worktree,
      firstTab,
      firstRoot,
      snapshot
    )
    if (opened) {
      return opened
    }
  }

  const created = unwrapHerdrResponse<{
    workspace: HerdrWorkspace
    tab: HerdrTab
    root_pane: HerdrPane
  }>(
    await transport.request(sessionName, 'workspace.create', {
      cwd: worktree.path,
      label: worktree.displayName || basename(worktree.path),
      focus: false
    })
  )
  await reportOrcaWorkspaceBinding(transport, sessionName, created.workspace.workspace_id, binding)
  created.workspace.tokens = {
    ...created.workspace.tokens,
    [ORCA_BINDING_TOKEN]: binding
  }
  snapshot.workspaces.push(created.workspace)
  snapshot.tabs.push(created.tab)
  snapshot.panes.push(created.root_pane)

  const firstLeafId = firstTerminalLeafId(firstRoot)
  if (firstTab && firstLeafId) {
    // Claim binding for the first pane
    const binding = orcaPaneBinding(projectId, firstLeafId)
    if (created.root_pane.tokens?.[ORCA_BINDING_TOKEN] === binding) {
      // already bound
    } else {
      await transport.request(sessionName, 'pane.report_metadata', {
        pane_id: created.root_pane.pane_id,
        source: ORCA_METADATA_SOURCE,
        tokens: { [ORCA_BINDING_TOKEN]: binding }
      })
      created.root_pane.tokens = { ...created.root_pane.tokens, [ORCA_BINDING_TOKEN]: binding }
    }
  }
  return created.workspace
}

async function openStockWorktree(
  transport: HerdrHostTransport,
  sessionName: string,
  projectId: string,
  worktree: HerdrWorktreeDescriptor,
  firstTab: TerminalTab | undefined,
  firstRoot: TerminalPaneLayoutNode | null,
  snapshot: HerdrSessionSnapshot
): Promise<HerdrWorkspace | null> {
  let opened: OpenedStockWorktree
  try {
    opened = unwrapHerdrResponse<OpenedStockWorktree>(
      await transport.request(sessionName, 'worktree.open', {
        cwd: worktree.repoPath,
        path: worktree.path,
        label: worktree.displayName || basename(worktree.path),
        focus: false
      })
    )
  } catch (error) {
    if (!(error instanceof HerdrRuntimeError) || error.code !== 'not_git_worktree') {
      throw error
    }
    return null
  }
  const binding = orcaWorkspaceBinding(projectId, worktree)
  const { workspace, tab, root_pane: rootPane, already_open: alreadyOpen } = opened
  await reportOrcaWorkspaceBinding(transport, sessionName, workspace.workspace_id, binding)
  workspace.tokens = { ...workspace.tokens, [ORCA_BINDING_TOKEN]: binding }
  if (alreadyOpen) {
    return workspace
  }
  snapshot.workspaces.push(workspace)
  snapshot.tabs.push(tab)
  snapshot.panes.push(rootPane)

  const firstLeafId = firstTerminalLeafId(firstRoot)
  if (firstTab && firstLeafId) {
    const binding = orcaPaneBinding(projectId, firstLeafId)
    if (rootPane.tokens?.[ORCA_BINDING_TOKEN] === binding) {
      // already bound
    } else {
      await transport.request(sessionName, 'pane.report_metadata', {
        pane_id: rootPane.pane_id,
        source: ORCA_METADATA_SOURCE,
        tokens: { [ORCA_BINDING_TOKEN]: binding }
      })
      rootPane.tokens = { ...rootPane.tokens, [ORCA_BINDING_TOKEN]: binding }
    }
  }
  return workspace
}
