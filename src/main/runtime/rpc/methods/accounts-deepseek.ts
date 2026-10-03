import { defineMethod } from '../core'
import {
  DeepSeekAccountOwnerParams,
  SaveDeepSeekApiKeyParams
} from '../../../../shared/rpc-contract/deepseek-account-params'

export const DEEPSEEK_ACCOUNT_METHODS = [
  defineMethod({
    name: 'accounts.deepSeekStatus',
    params: null,
    handler: async (_params, { runtime }) => runtime.getDeepSeekAccountStatus()
  }),
  defineMethod({
    name: 'accounts.saveDeepSeekApiKey',
    params: SaveDeepSeekApiKeyParams,
    handler: async (params, { runtime }) =>
      runtime.saveDeepSeekApiKey(params.ownerId, params.apiKey)
  }),
  defineMethod({
    name: 'accounts.removeDeepSeekApiKey',
    params: DeepSeekAccountOwnerParams,
    handler: async (params, { runtime }) => runtime.removeDeepSeekApiKey(params.ownerId)
  }),
  defineMethod({
    name: 'accounts.refreshDeepSeek',
    params: DeepSeekAccountOwnerParams,
    handler: async (params, { runtime }) => runtime.refreshDeepSeekBalance(params.ownerId)
  })
]
