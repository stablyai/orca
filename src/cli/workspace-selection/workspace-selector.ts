import { resolve as resolvePath } from 'node:path'
import { resolveFolderWorkspaceSelector } from './folder-workspace-selector'
import { resolveCallerDistroPathSelector } from './wsl-caller-path-selector'
import type { RuntimeClient } from '../runtime/client'
import { RuntimeClientError } from '../runtime/types'
import { assertLocalCwdWorktreeSelector } from '../hosts/local-environment-selector'
import { isLaunchedByAnotherRuntime } from '../runtime/runtime-source-fence'
import { getOptionalStringFlag, getRequiredStringFlag } from '../arguments/flags'
import { readEnclosingWorkspaceCatalog } from './enclosing-workspace-catalog'
import {
  getCallerExecutionHostId,
  getCallerWorkspaceIds,
  selectWorktreeCreateCwdContext,
  selectEnclosingWorktreeSelectionOnHost,
  selectCallerTerminalWorkspace,
  selectorPurpose,
  type WorkspaceSelectionPurpose,
  type HostScopedWorktreeSelection
} from './caller-host-worktree-selection'

export function buildCurrentWorktreeSelector(cwd: string): string {
  return `path:${resolvePath(cwd)}`
}

export function normalizeWorktreeSelector(selector: string, cwd: string): string {
  if (selector === 'active' || selector === 'current') {
    return buildCurrentWorktreeSelector(cwd)
  }
  return selector
}

/** A parent keeps its selector: the runtime's parent resolver classifies it by kind, with parent rules. */
export async function normalizeWorktreeSelectorForCaller(
  selector: string,
  cwd: string,
  client: RuntimeClient,
  purpose: WorkspaceSelectionPurpose = 'worktree'
): Promise<string> {
  const normalized = await resolveCallerDistroPathSelector(
    normalizeWorktreeSelector(selector, cwd),
    cwd,
    client
  )
  return purpose === 'parent' ? normalized : resolveFolderWorkspaceSelector(normalized, client)
}

export async function resolveCurrentWorktreeSelector(
  cwd: string,
  client: RuntimeClient,
  purpose: WorkspaceSelectionPurpose = 'worktree'
): Promise<string> {
  return (await resolveCurrentWorktreeSelection(cwd, client, purpose)).selector
}

export async function resolveCurrentWorktreeSelection(
  cwd: string,
  client: RuntimeClient,
  purpose: WorkspaceSelectionPurpose = 'worktree'
): Promise<HostScopedWorktreeSelection> {
  assertLocalCwdWorktreeSelector('current', client)

  // Preserve the repo id: duplicate registrations can make a bare path selector ambiguous.
  const selection = selectEnclosingWorktreeSelectionOnHost(
    await readEnclosingWorkspaceCatalog(client, cwd),
    cwd,
    getCallerExecutionHostId(),
    getCallerWorkspaceIds(),
    purpose
  )
  if (!selection) {
    throw new RuntimeClientError(
      'selector_not_found',
      `No Orca workspace contains the current directory: ${resolvePath(cwd)}`
    )
  }
  return selection
}

export async function resolveWorktreeCreateCwdContext(
  cwd: string,
  client: RuntimeClient,
  inferRepo: boolean,
  inferParent = true
): Promise<ReturnType<typeof selectWorktreeCreateCwdContext>> {
  assertLocalCwdWorktreeSelector('current', client)
  const catalog = await readEnclosingWorkspaceCatalog(client, cwd)
  return selectWorktreeCreateCwdContext(catalog, cwd, inferRepo, inferParent)
}

export async function getOptionalWorktreeSelector(
  flags: Map<string, string | boolean>,
  name: string,
  cwd: string,
  client: RuntimeClient
): Promise<string | undefined> {
  const value = getOptionalStringFlag(flags, name)
  if (!value) {
    return undefined
  }
  if (value === 'active' || value === 'current') {
    assertLocalCwdWorktreeSelector(value, client)
    return await resolveCurrentWorktreeSelector(cwd, client, selectorPurpose(name))
  }
  return await normalizeWorktreeSelectorForCaller(value, cwd, client, selectorPurpose(name))
}

export async function getRequiredWorktreeSelector(
  flags: Map<string, string | boolean>,
  name: string,
  cwd: string,
  client: RuntimeClient
): Promise<string> {
  const value = getRequiredStringFlag(flags, name)
  if (value === 'active' || value === 'current') {
    assertLocalCwdWorktreeSelector(value, client)
    return await resolveCurrentWorktreeSelector(cwd, client, selectorPurpose(name))
  }
  return await normalizeWorktreeSelectorForCaller(value, cwd, client, selectorPurpose(name))
}

// Remote commands leave worktree unset to use server-side focus.
export async function getBrowserWorktreeSelector(
  flags: Map<string, string | boolean>,
  cwd: string,
  client: RuntimeClient,
  purpose: WorkspaceSelectionPurpose = 'worktree'
): Promise<string | undefined> {
  const value = getOptionalStringFlag(flags, 'worktree')
  if (value === 'all') {
    return undefined
  }
  if (value) {
    if (value === 'active' || value === 'current') {
      assertLocalCwdWorktreeSelector(value, client)
      return await resolveCurrentWorktreeSelector(cwd, client, purpose)
    }
    return await normalizeWorktreeSelectorForCaller(value, cwd, client)
  }
  if (client.isRemote) {
    return undefined
  }
  // The folder reads fall back on their own; a worktree-list failure surfaces rather than retargeting.
  const catalog = await readEnclosingWorkspaceCatalog(client, cwd)
  const hostId = getCallerExecutionHostId()
  const enclosing = selectEnclosingWorktreeSelectionOnHost(
    catalog,
    cwd,
    hostId,
    getCallerWorkspaceIds(),
    purpose
  )
  if (enclosing || isLaunchedByAnotherRuntime(process.env, client.userDataPath)) {
    return enclosing?.selector
  }
  // An Orca terminal knows its workspace; without this an unmanaged cwd lands in the focused one.
  return selectCallerTerminalWorkspace(catalog, hostId)
}
