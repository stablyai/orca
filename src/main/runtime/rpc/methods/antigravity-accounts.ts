import { defineMethod } from '../core'
import {
  AntigravityAccountMutationParams,
  AntigravityAccountTargetParams
} from '../../../../shared/rpc-contract/antigravity-accounts-params'
import { runAntigravityAccountOperation } from '../../../antigravity/native-account-host'

export const ANTIGRAVITY_ACCOUNT_METHODS = [
  defineMethod({
    name: 'accounts.antigravityList',
    permission: 'workspace',
    params: AntigravityAccountTargetParams,
    handler: async (target) => runAntigravityAccountOperation(target, 'List')
  }),
  defineMethod({
    name: 'accounts.antigravityAddCurrent',
    permission: 'accounts-admin',
    params: AntigravityAccountTargetParams,
    handler: async (target) => runAntigravityAccountOperation(target, 'AddCurrent')
  }),
  defineMethod({
    name: 'accounts.antigravitySelect',
    permission: 'accounts-admin',
    params: AntigravityAccountMutationParams,
    handler: async ({ target, accountId }) =>
      runAntigravityAccountOperation(target, 'Select', accountId)
  }),
  defineMethod({
    name: 'accounts.antigravityRemove',
    permission: 'accounts-admin',
    params: AntigravityAccountMutationParams,
    handler: async ({ target, accountId }) =>
      runAntigravityAccountOperation(target, 'Remove', accountId)
  })
]
