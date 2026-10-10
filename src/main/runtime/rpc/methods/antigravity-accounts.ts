import { defineMethod } from '../core'
import {
  AntigravityAccountMutationParams,
  AntigravityAccountTargetParams
} from '../../../../shared/rpc-contract/antigravity-accounts-params'
import { getAntigravityAccountService } from '../../../antigravity/native-account-host'

export const ANTIGRAVITY_ACCOUNT_METHODS = [
  defineMethod({
    name: 'accounts.antigravityList',
    permission: 'workspace',
    params: AntigravityAccountTargetParams,
    handler: async (target) => getAntigravityAccountService(target).listAccounts()
  }),
  defineMethod({
    name: 'accounts.antigravityAddCurrent',
    permission: 'accounts-admin',
    params: AntigravityAccountTargetParams,
    handler: async (target) => getAntigravityAccountService(target).addCurrentAccount()
  }),
  defineMethod({
    name: 'accounts.antigravitySelect',
    permission: 'accounts-admin',
    params: AntigravityAccountMutationParams,
    handler: async ({ target, accountId }) =>
      getAntigravityAccountService(target).selectAccount(accountId)
  }),
  defineMethod({
    name: 'accounts.antigravityRemove',
    permission: 'accounts-admin',
    params: AntigravityAccountMutationParams,
    handler: async ({ target, accountId }) =>
      getAntigravityAccountService(target).removeAccount(accountId)
  })
]
