import { isWorkspaceKey } from '../../shared/workspace-scope'
import { getOptionalStringFlag } from '../flags'
import { RuntimeClientError, type RuntimeClient } from '../runtime-client'
import { getOptionalWorktreeSelector } from '../selectors'

export type CreateParentSelector = {
  parentWorktree?: string
  parentWorkspace?: string
}

const CREATE_PARENT_CONFLICT_MESSAGE = 'Choose either one parent selector or --no-parent.'

export function assertCreateParentFlagsCompatible(flags: Map<string, string | boolean>): void {
  if (flags.has('parent-worktree') && flags.get('no-parent') === true) {
    throw new RuntimeClientError('invalid_argument', CREATE_PARENT_CONFLICT_MESSAGE)
  }
  const parentWorktree = flags.get('parent-worktree')
  if (
    flags.has('parent-worktree') &&
    (typeof parentWorktree !== 'string' || parentWorktree === '')
  ) {
    throw new RuntimeClientError('invalid_argument', 'Missing required --parent-worktree')
  }
}

function getWorkspaceKeyParentSelector(selector: string): string | undefined {
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
    // Why: create exposes one public parent flag, while the runtime still needs
    // workspace keys to preserve folder/worktree lineage accurately.
    return { parentWorkspace }
  }

  const parentWorktree = await getOptionalWorktreeSelector(flags, 'parent-worktree', cwd, client)
  const resolvedParentWorkspace = parentWorktree
    ? getWorkspaceKeyParentSelector(parentWorktree)
    : undefined
  if (resolvedParentWorkspace) {
    // Why: active/current may resolve to a folder workspace pseudo-worktree id.
    return { parentWorkspace: resolvedParentWorkspace }
  }

  return {
    parentWorktree
  }
}
