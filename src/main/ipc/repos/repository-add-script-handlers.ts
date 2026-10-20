import { ipcMain } from 'electron'
import type {
  RepositoryAddScriptDecisionResult,
  RepositoryAddScriptOutcome
} from '../../../shared/repository-add-script-types'
import {
  RepositoryAddScriptDecideParams,
  RepositoryAddScriptIdentityParams
} from '../../../shared/rpc-contract/repository-add-script-params'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { parseProjectGroupIpcArgs } from './repo-ipc-arg-schemas'

// The renderer holds no script, path or target here: it names a token it was offered and the
// service re-checks that identity against its own record.
export function registerRepositoryAddScriptHandlers(
  runtime: Pick<OrcaRuntimeService, 'decideRepositoryAddScript' | 'getRepositoryAddScriptOutcome'>
): void {
  ipcMain.handle(
    'repos:decideAddScript',
    (_event, rawArgs: unknown): Promise<RepositoryAddScriptDecisionResult> =>
      runtime.decideRepositoryAddScript(
        parseProjectGroupIpcArgs(
          RepositoryAddScriptDecideParams,
          rawArgs,
          'repository_add_script_decide_invalid_args'
        )
      )
  )

  ipcMain.handle(
    'repos:getAddScriptOutcome',
    (_event, rawArgs: unknown): RepositoryAddScriptOutcome | null =>
      runtime.getRepositoryAddScriptOutcome(
        parseProjectGroupIpcArgs(
          RepositoryAddScriptIdentityParams,
          rawArgs,
          'repository_add_script_outcome_invalid_args'
        )
      )
  )
}
