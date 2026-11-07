import { isWorkspaceKey, worktreeWorkspaceKey } from '../../shared/workspace-scope'
import { getOptionalStringFlag } from '../flags'
import { RuntimeClientError, type RuntimeClient } from '../runtime-client'
import { getOptionalWorktreeSelector } from '../selectors'
import { getOptionalParentSelector } from '../caller-folder-workspace'
import { callerOrcaClient } from './worktree-parent-fields'

export type CreateParentSelector = {
  parentWorktree?: string
  parentWorkspace?: string
  /** active/current against a server: the parent is on this machine, not the server. */
  onCallerMachine?: true
}

const CREATE_PARENT_CONFLICT_MESSAGE = 'Choose either one parent selector or --no-parent.'

export function assertWorktreeParentFlagsCompatible(
  flags: Map<string, string | boolean>,
  conflictMessage: string = CREATE_PARENT_CONFLICT_MESSAGE
): void {
  if (flags.has('parent-worktree') && flags.get('no-parent') === true) {
    throw new RuntimeClientError('invalid_argument', conflictMessage)
  }
  const parentWorktree = flags.get('parent-worktree')
  if (
    flags.has('parent-worktree') &&
    (typeof parentWorktree !== 'string' || parentWorktree === '')
  ) {
    throw new RuntimeClientError('invalid_argument', 'Missing required --parent-worktree')
  }
}

export function getWorkspaceKeyParentSelector(selector: string): string | undefined {
  const rawSelector = selector.startsWith('id:') ? selector.slice('id:'.length) : selector
  return isWorkspaceKey(rawSelector) ? rawSelector : undefined
}

export async function resolveCreateParentSelector(
  flags: Map<string, string | boolean>,
  cwd: string,
  client: RuntimeClient
): Promise<CreateParentSelector> {
  const rawParentWorktree = getOptionalStringFlag(flags, 'parent-worktree')
  if (!rawParentWorktree) {
    return {}
  }

  const parentWorkspace = getWorkspaceKeyParentSelector(rawParentWorktree)
  if (parentWorkspace) {
    // The public parent flag can name either kind; runtime workspace keys preserve folder lineage.
    return { parentWorkspace }
  }

  if (client.isRemote && (rawParentWorktree === 'active' || rawParentWorktree === 'current')) {
    const callerParent = await getOptionalWorktreeSelector(
      flags,
      'parent-worktree',
      cwd,
      callerOrcaClient(client)
    )
    return { parentWorktree: callerParent, onCallerMachine: true }
  }
  const parentWorktree = await getOptionalParentSelector(flags, cwd, client)
  const resolvedParentWorkspace = parentWorktree
    ? getWorkspaceKeyParentSelector(parentWorktree)
    : undefined
  if (resolvedParentWorkspace) {
    // active/current can resolve to a folder workspace.
    return { parentWorkspace: resolvedParentWorkspace }
  }

  return {
    parentWorktree
  }
}

export function getEnvParentWorkspace(): string | undefined {
  const workspaceId = process.env.ORCA_WORKSPACE_ID
  if (typeof workspaceId === 'string' && isWorkspaceKey(workspaceId)) {
    return workspaceId
  }
  const worktreeId = process.env.ORCA_WORKTREE_ID
  if (typeof worktreeId === 'string' && worktreeId.length > 0) {
    return isWorkspaceKey(worktreeId) ? worktreeId : worktreeWorkspaceKey(worktreeId)
  }
  return undefined
}
