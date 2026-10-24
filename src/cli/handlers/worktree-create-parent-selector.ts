import type { RuntimeStatus, RuntimeWorktreeRecord } from '../../shared/runtime-types'
import type { ParentWorktreeRef } from '../../shared/worktree/lineage-types'
import { assertCrossMachineLineageSupported } from '../../shared/worktree-runtime-capabilities'
import {
  isWorkspaceKey,
  parseWorkspaceKey,
  worktreeWorkspaceKey
} from '../../shared/workspace-scope'
import { getOptionalStringFlag } from '../flags'
import { RuntimeClientError, RuntimeClient } from '../runtime-client'
import { getOptionalWorktreeSelector } from '../selectors'

export type CreateParentSelector = {
  parentWorktree?: string
  parentWorkspace?: string
  origin?: 'caller' | 'target'
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
    // Why: create exposes one public parent flag, while the runtime still needs
    // workspace keys to preserve folder/worktree lineage accurately.
    return { parentWorkspace, origin: 'target' }
  }

  const callerRelative = rawParentWorktree === 'active' || rawParentWorktree === 'current'
  const parentWorktree = await getOptionalWorktreeSelector(
    flags,
    'parent-worktree',
    cwd,
    callerRelative ? localParentClient(client) : client
  )
  const resolvedParentWorkspace = parentWorktree
    ? getWorkspaceKeyParentSelector(parentWorktree)
    : undefined
  if (resolvedParentWorkspace) {
    // Why: active/current may resolve to a folder workspace pseudo-worktree id.
    return { parentWorkspace: resolvedParentWorkspace, origin: 'caller' }
  }

  return {
    parentWorktree,
    origin: callerRelative ? 'caller' : 'target'
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

export function localParentClient(client: RuntimeClient): RuntimeClient {
  return client.isRemote ? new RuntimeClient(client.userDataPath, 60_000, null, null) : client
}

export async function resolveCallerParentRef(
  client: RuntimeClient,
  selector: string | undefined,
  explicit: boolean
): Promise<ParentWorktreeRef | undefined> {
  if (!selector || !client.isRemote) {
    return undefined
  }
  const local = localParentClient(client)
  const workspace = parseWorkspaceKey(selector)
  const parentSelector = workspace?.type === 'worktree' ? `id:${workspace.worktreeId}` : selector
  let parent: RuntimeWorktreeRecord
  try {
    parent = (
      await local.call<{ worktree: RuntimeWorktreeRecord }>('worktree.show', {
        worktree: parentSelector
      })
    ).result.worktree
  } catch (error) {
    if (explicit) {
      throw error
    }
    return undefined
  }
  const instanceId = parent.instanceId ?? (parent.id.startsWith('folder:') ? parent.id : undefined)
  if (!instanceId) {
    if (explicit) {
      throw new Error('The parent workspace has no identity. Refresh it and try again.')
    }
    return undefined
  }
  const status = (await client.call<RuntimeStatus>('status.get')).result
  try {
    assertCrossMachineLineageSupported(
      status.capabilities,
      client.environmentSelector ?? 'the connected server'
    )
  } catch (error) {
    if (explicit) {
      throw error
    }
    console.error(
      `warning: ${error instanceof Error ? error.message : 'Update the connected server to nest across machines.'} Creating without a parent.`
    )
    return undefined
  }
  return { worktreeId: parent.id, instanceId, external: true }
}
