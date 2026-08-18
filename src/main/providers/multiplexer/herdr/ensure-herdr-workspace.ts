import { firstTerminalLeafId } from '../../../../shared/herdr-session-identity'
import type {
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode,
  TerminalTab
} from '../../../../shared/terminal-tab-types'
import type { Project } from '../../../../shared/project-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { basename, normalize } from 'node:path'
import {
  findUniqueHerdrMatch,
  ORCA_BINDING_TOKEN,
  ORCA_METADATA_SOURCE,
  orcaPaneBinding,
  orcaWorkspaceBinding,
  reportOrcaWorkspaceBinding
} from './herdr-binding-metadata'
import type {
  HerdrHostTransport,
  HerdrPane,
  HerdrSessionSnapshot,
  HerdrTab,
  HerdrWorkspace
} from './herdr-runtime-contract'
import { HerdrRuntimeError, unwrapHerdrResponse } from './herdr-runtime-contract'

export type HerdrWorktreeDescriptor = Pick<
  Worktree,
  'id' | 'instanceId' | 'path' | 'displayName'
> & {
  repoPath?: string
}

export type HerdrProjectHostGraph = {
  project: Project
  worktrees: HerdrWorktreeDescriptor[]
  tabsByWorktreeId: Record<string, TerminalTab[]>
  layoutsByTabId: Record<string, TerminalLayoutSnapshot>
  persistedPaneIdsByLeafId?: Record<string, string>
}

export function isLinkedHerdrWorktree(worktree: HerdrWorktreeDescriptor): boolean {
  if (!worktree.repoPath) {
    return false
  }
  return normalize(worktree.path) !== normalize(worktree.repoPath)
}

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

  const adoptable = findAdoptableWorkspace(snapshot.workspaces, worktree)
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

export async function enrichHerdrWorkspaceCheckouts(
  transport: HerdrHostTransport,
  sessionName: string,
  snapshot: HerdrSessionSnapshot
): Promise<void> {
  for (const workspace of snapshot.workspaces) {
    if (workspace.cwd || workspace.path || workspace.worktree?.checkout_path) {
      continue
    }
    try {
      const details = unwrapHerdrResponse<{ workspace: HerdrWorkspace }>(
        await transport.request(sessionName, 'workspace.get', {
          workspace_id: workspace.workspace_id
        })
      ).workspace
      workspace.cwd = details.cwd ?? workspace.cwd
      workspace.path = details.path ?? workspace.path
      workspace.worktree = details.worktree ?? workspace.worktree
    } catch {
      // Skinny snapshot records stay adoptable by unique label.
    }
  }
}

export function findHerdrWorkspaceForWorktree(
  snapshot: HerdrSessionSnapshot,
  projectId: string,
  worktree: { id: string; path: string; displayName?: string }
): HerdrWorkspace | undefined {
  const binding = orcaWorkspaceBinding(projectId, worktree)
  const bound = snapshot.workspaces.find(
    (workspace) => workspace.tokens?.[ORCA_BINDING_TOKEN] === binding
  )
  if (bound) {
    return bound
  }
  return findAdoptableWorkspace(snapshot.workspaces, worktree) ?? undefined
}

function findAdoptableWorkspace(
  workspaces: HerdrWorkspace[],
  worktree: { path: string; displayName?: string }
): HerdrWorkspace | null {
  if (worktree.path) {
    const byCheckout = findUniqueHerdrMatch(
      workspaces,
      (workspace) => workspaceMatchesCheckout(workspace, worktree.path),
      `workspace checkout ${worktree.path}`
    )
    if (byCheckout) {
      return byCheckout
    }
  }
  const expectedLabel = worktree.displayName || basename(worktree.path)
  const unbound = workspaces.filter((workspace) => !workspace.tokens?.[ORCA_BINDING_TOKEN])
  if (unbound.length === 1 && unbound[0].label === expectedLabel) {
    return unbound[0]
  }
  return findUniqueHerdrMatch(
    unbound,
    (workspace) => workspace.label === expectedLabel,
    `workspace label ${expectedLabel}`
  )
}

function workspaceMatchesCheckout(workspace: HerdrWorkspace, checkoutPath: string): boolean {
  const expected = normalize(checkoutPath)
  return [workspace.worktree?.checkout_path, workspace.cwd, workspace.path].some(
    (candidate) => candidate !== undefined && normalize(candidate) === expected
  )
}
