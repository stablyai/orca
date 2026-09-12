import {
  AiVaultSearchRequestSchema,
  AiVaultSearchStatusRequestSchema
} from '../../../../shared/ai-vault-search-contract'
import {
  searchSessionService,
  sessionSearchServiceStatus
} from '../../../ai-vault-search/session-search-service-registry'
import { defineMethod } from '../core'
import { restampAiVaultListResult } from '../../../ai-vault/session-list-results'
import type { AiVaultPrepareSessionResumeArgs } from '../../../../shared/ai-vault-resume-preparation'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { describeAiVaultScanError } from '../../../../shared/ai-vault-scan-error-message'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import {
  assertLegacyAiVaultResumeAllowed,
  projectStructuredAiVaultSessions
} from '../../../ai-vault/structured-session-ownership'
import {
  AiVaultListSessionsParams,
  AiVaultPrepareSessionResumeParams,
  AiVaultSessionTitlesParams
} from '../../../../shared/rpc-contract/ai-vault-params'
export { AiVaultListSessionsParams, AiVaultPrepareSessionResumeParams, AiVaultSessionTitlesParams }

export const AI_VAULT_METHODS = [
  defineMethod({
    name: 'aiVault.searchSessions',
    params: AiVaultSearchRequestSchema,
    handler: (params, { clientKind }) =>
      searchSessionService(params, clientKind ? 'relay' : 'runtime')
  }),
  defineMethod({
    name: 'aiVault.searchStatus',
    params: AiVaultSearchStatusRequestSchema,
    handler: (params) => sessionSearchServiceStatus(params)
  }),
  defineMethod({
    name: 'aiVault.resolveSessionTitles',
    params: AiVaultSessionTitlesParams,
    handler: (params, { runtime, signal }) =>
      runtime.resolveAiVaultSessionTitles(params.requests, signal)
  }),
  defineMethod({
    name: 'aiVault.listSessions',
    params: AiVaultListSessionsParams,
    handler: async (params, { runtime, clientKind, clientCapabilities }) => {
      await runtime.ensureStructuredAgentSessionHost()
      let result
      try {
        result = await runtime.listAiVaultSessions({
          limit: params.unlimited ? undefined : params.limit,
          unlimited: params.unlimited,
          force: params.force,
          scopePaths: params.scopePaths
        })
      } catch (error) {
        if (error instanceof Error) {
          error.message = describeAiVaultScanError(error.message)
          throw error
        }
        throw new Error(describeAiVaultScanError(String(error)))
      }
      // Why: web clients consume this response directly (no parent-side retag),
      // so sessions must come back stamped as the runtime host they addressed.
      const stamped = params.executionHostId
        ? restampAiVaultListResult(result, params.executionHostId)
        : result
      return projectStructuredAiVaultSessions(
        stamped,
        clientKind === undefined ||
          (clientCapabilities?.includes(STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY) ?? false)
      )
    }
  }),
  defineMethod({
    name: 'aiVault.prepareSessionResume',
    params: AiVaultPrepareSessionResumeParams,
    handler: async (params, { runtime }) => {
      const args: AiVaultPrepareSessionResumeArgs = {
        agent: params.agent,
        ...(params.sessionId ? { sessionId: params.sessionId } : {}),
        filePath: params.filePath,
        codexHome: params.codexHome,
        // Why: the RPC executes on the transcript-owning host; never let a
        // client-provided runtime/SSH stamp escape that host boundary.
        executionHostId: LOCAL_EXECUTION_HOST_ID
      }
      await runtime.ensureStructuredAgentSessionHost()
      assertLegacyAiVaultResumeAllowed(args)
      return runtime.prepareAiVaultSessionResume(args)
    }
  })
]
