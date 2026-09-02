import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { requiredString } from '../schemas'
import { RepoSelector } from './github-repo-target-schemas'

const BindableAccounts = RepoSelector.extend({
  refreshCapability: z.boolean().optional()
})

const ValidateAccountBinding = RepoSelector.extend({
  host: requiredString('Missing host'),
  user: requiredString('Missing user')
})

export const GITHUB_ACCOUNT_BINDING_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'github.listBindableAccounts',
    params: BindableAccounts,
    handler: async (params, { runtime }) =>
      runtime.listGitHubBindableAccounts(params.repo, {
        refreshCapability: params.refreshCapability
      })
  }),
  defineMethod({
    name: 'github.validateAccountBinding',
    params: ValidateAccountBinding,
    handler: async (params, { runtime }) =>
      runtime.validateGitHubAccountBinding(params.repo, {
        host: params.host,
        user: params.user
      })
  })
]
