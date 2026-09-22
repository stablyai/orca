import { defineMethod } from '../core'
import {
  BindableAccounts,
  ValidateAccountBinding
} from '../../../../shared/rpc-contract/github-account-binding-params'

export const GITHUB_ACCOUNT_BINDING_METHODS = [
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
