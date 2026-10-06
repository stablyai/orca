import { defineMethod } from '../core'
import {
  AntigravityAccountMutationParams,
  AntigravityAccountTargetParams
} from '../../../../shared/rpc-contract/antigravity-accounts-params'
import { runAntigravityAccountOperation } from '../../../antigravity/native-account-host'

export const ANTIGRAVITY_ACCOUNT_METHODS = [
  defineMethod({
    name: 'accounts.antigravityList',
    params: AntigravityAccountTargetParams,
    handler: async (target) => runAntigravityAccountOperation(target, 'List')
  }),
  defineMethod({
    name: 'accounts.antigravityAddCurrent',
    params: AntigravityAccountTargetParams,
    handler: async (target) => runAntigravityAccountOperation(target, 'AddCurrent')
  }),
  defineMethod({
    name: 'accounts.antigravitySelect',
    params: AntigravityAccountMutationParams,
    handler: async ({ target, accountId }) =>
      runAntigravityAccountOperation(target, 'Select', accountId)
  }),
  defineMethod({
    name: 'accounts.antigravityRemove',
    params: AntigravityAccountMutationParams,
    handler: async ({ target, accountId }) =>
      runAntigravityAccountOperation(target, 'Remove', accountId)
  })
]
