import { defineMethod } from '../../core'
import {
  ImportClaudeHomeParams,
  AddCodexFromHomeParams
} from '../../../../../shared/rpc-contract/accounts/accounts-params'

export const ACCOUNT_HOME_IMPORT_METHODS = [
  defineMethod({
    name: 'accounts.addClaudeFromHome',
    permission: 'accounts-admin',
    params: ImportClaudeHomeParams,
    handler: async (params, { runtime, clientKind }) => {
      if (clientKind !== undefined) {
        throw new Error('Importing Claude accounts is only available on the Orca host runtime.')
      }
      return runtime.importClaudeHome(params.sourceHome, params.importHistory)
    }
  }),
  defineMethod({
    name: 'accounts.addCodexFromHome',
    permission: 'accounts-admin',
    params: AddCodexFromHomeParams,
    handler: async (params, { runtime, clientKind }) => {
      if (clientKind !== undefined) {
        throw new Error('Adding Codex accounts is only available on the Orca host runtime.')
      }
      return runtime.addCodexAccountFromHome(params.sourceHome, {
        importHistory: params.importHistory,
        runtime: params.runtime,
        wslDistro: params.wslDistro ?? null
      })
    }
  })
]
