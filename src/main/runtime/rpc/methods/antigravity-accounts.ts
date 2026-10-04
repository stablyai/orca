import { defineMethod } from '../core'
import {
  AntigravityAccountMutationParams,
  AntigravityAccountTargetParams
} from '../../../../shared/rpc-contract/antigravity-accounts-params'
import { getAntigravityAccountService } from '../../../antigravity/native-account-host'

export const ANTIGRAVITY_ACCOUNT_METHODS = [
  defineMethod({
    name: 'accounts.antigravityList',
    params: AntigravityAccountTargetParams,
    handler: async (target) => getAntigravityAccountService(target).listAccounts()
  }),
  defineMethod({
    name: 'accounts.antigravityAddCurrent',
    params: AntigravityAccountTargetParams,
    handler: async (target) => getAntigravityAccountService(target).addCurrentAccount()
  }),
  defineMethod({
    name: 'accounts.antigravitySelect',
    params: AntigravityAccountMutationParams,
    handler: async ({ target, accountId }) =>
      getAntigravityAccountService(target).selectAccount(accountId)
  }),
  defineMethod({
    name: 'accounts.antigravityRemove',
    params: AntigravityAccountMutationParams,
    handler: async ({ target, accountId }) =>
      getAntigravityAccountService(target).removeAccount(accountId)
  })
]
