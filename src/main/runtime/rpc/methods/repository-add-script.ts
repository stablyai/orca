import { defineMethod } from '../core'
import {
  REPOSITORY_ADD_SCRIPT_DECIDE_METHOD,
  REPOSITORY_ADD_SCRIPT_OUTCOME_METHOD
} from '../../../../shared/repository-add-script-wire'
import {
  RepositoryAddScriptDecideParams,
  RepositoryAddScriptIdentityParams
} from '../../../../shared/rpc-contract/repository-add-script-params'

// Workspace scope, same as the registration that offered the script; neither method takes a
// script, path or target, and there is no way to offer, list or revoke a token from here.
export const REPOSITORY_ADD_SCRIPT_METHODS = [
  defineMethod({
    name: REPOSITORY_ADD_SCRIPT_DECIDE_METHOD,
    permission: 'workspace',
    params: RepositoryAddScriptDecideParams,
    handler: async (params, { runtime }) => ({
      result: await runtime.decideRepositoryAddScript(params)
    })
  }),
  defineMethod({
    name: REPOSITORY_ADD_SCRIPT_OUTCOME_METHOD,
    permission: 'workspace',
    params: RepositoryAddScriptIdentityParams,
    handler: (params, { runtime }) => ({ outcome: runtime.getRepositoryAddScriptOutcome(params) })
  })
]
