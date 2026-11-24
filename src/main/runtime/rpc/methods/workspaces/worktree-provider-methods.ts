import { defineMethod } from '../../core'
import {
  WorktreeAcquire,
  WorktreeProviderList,
  WorktreeProviderTrust,
  WorktreeRelease
} from '../../../../../shared/rpc-contract/workspaces/worktree-provider-params'

export const WORKTREE_PROVIDER_METHODS = [
  defineMethod({
    name: 'worktree.acquire',
    permission: 'workspace',
    params: WorktreeAcquire,
    handler: async (params, { runtime }) =>
      runtime.acquireManagedProviderWorktree(params.repo, {
        provider: params.provider,
        ...(params.profile ? { profile: params.profile } : {})
      })
  }),
  defineMethod({
    name: 'worktree.release',
    permission: 'workspace',
    params: WorktreeRelease,
    handler: async (params, { runtime }) =>
      runtime.releaseManagedProviderWorktree(params.worktree, {
        ...(params.hostId ? { hostId: params.hostId } : {}),
        force: params.force === true,
        forget: params.forget === true
      })
  }),
  defineMethod({
    name: 'worktree.providers.list',
    permission: 'workspace',
    params: WorktreeProviderList,
    handler: async (params, { runtime }) => runtime.listManagedWorktreeProviders(params.repo)
  }),
  defineMethod({
    name: 'worktree.providers.trust',
    permission: 'workspace',
    params: WorktreeProviderTrust,
    handler: async (params, { runtime }) =>
      runtime.trustManagedWorktreeProviders(params.repo, {
        expectedConfigHash: params.expectedConfigHash
      })
  })
]
