import { ProviderList } from '../../../../../shared/rpc-contract/provider-params'
import { defineMethod, type RpcContext } from '../../core'
import type { RecipeWorkspaceCreateParams } from '../../../../ephemeral-vm/recipe-workspace-create-params'

/** The workspace providers `worktree.create` with `target` accepts on this host. */
export const PROVIDER_LIST_METHOD = defineMethod({
  name: 'provider.list',
  permission: 'workspace',
  params: ProviderList,
  handler: (params, { runtime }) => runtime.listWorkspaceProviders(params.repo)
})

/** `worktree.create` with `target`: the provider makes a new host, then the workspace on it. */
/** `worktree.create` with `target`: the provider makes a new host, then the workspace on it.
 *  Null for every other create, which keeps the ordinary path. */
export function createWorkspaceOnProvider(
  params: RecipeWorkspaceCreateParams,
  context: RpcContext
): Promise<unknown> | null {
  if (params.target === undefined) {
    return null
  }
  // Why: a provider starts a machine from this computer's config; paired devices don't get to
  // start one until they have their own UI and confirmation for it.
  if (context.clientKind !== undefined) {
    return Promise.reject(
      Object.assign(
        new Error(
          "Provider workspaces are created from this computer's Orca app or CLI, not from a paired device."
        ),
        { code: 'forbidden' }
      )
    )
  }
  return context.runtime.dedupeWorktreeCreate(params, worktreeCreateDedupeKey(params), () =>
    context.runtime.createManagedRecipeWorkspace(params, {
      ...(context.signal ? { signal: context.signal } : {}),
      ...(context.reportProgress
        ? { onPhase: (phase, detail) => context.reportProgress?.({ phase, ...detail }) }
        : {})
    })
  )
}

// A provider create's key also names its target, so reusing a key elsewhere never returns this result.
function worktreeCreateDedupeKey(params: {
  clientMutationId?: string
  target?: { kind: string; id: string; pluginKey?: string }
}): string | undefined {
  if (!params.clientMutationId || !params.target) {
    return params.clientMutationId
  }
  const { kind, id, pluginKey } = params.target
  return `${kind}:${pluginKey ?? ''}/${id}:${params.clientMutationId}`
}
