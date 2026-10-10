import {
  AiVaultSearchRequestSchema,
  AiVaultSearchStatusRequestSchema,
  AiVaultSetSearchEnabledParamsSchema
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
import {
  assertLegacyAiVaultResumeAllowed,
  projectStructuredAiVaultSessions,
  searchWithStructuredOwners
} from '../../../ai-vault/structured-session-ownership'
import { ensureStructuredAgentSessionHostUnlessRefused } from '../../structured-agent-session-host-refusal'
import {
  clientOpensStructuredChatFromHistory,
  supportsStructuredAgentSessions
} from './structured-agent-session-policy'
import {
  AiVaultListSessionsParams,
  AiVaultPrepareSessionResumeParams,
  AiVaultSessionTitlesParams
} from '../../../../shared/rpc-contract/ai-vault-params'
export { AiVaultListSessionsParams, AiVaultPrepareSessionResumeParams, AiVaultSessionTitlesParams }

export const AI_VAULT_METHODS = [
  defineMethod({
    name: 'aiVault.searchSessions',
    permission: 'workspace',
    params: AiVaultSearchRequestSchema,
    handler: (params, context) => {
      const response = searchSessionService(params, context.clientKind ? 'relay' : 'runtime')
      // A client that reads no structured sessions keeps the transcript hit, as before.
      return supportsStructuredAgentSessions(context)
        ? searchWithStructuredOwners(response, {
            ensureHost: () => context.runtime.ensureStructuredAgentSessionHost(),
            opensChat: (agent) => clientOpensStructuredChatFromHistory(context, agent)
          })
        : response
    }
  }),
  defineMethod({
    name: 'aiVault.searchStatus',
    permission: 'workspace',
    params: AiVaultSearchStatusRequestSchema,
    handler: (params, { clientKind }) =>
      sessionSearchServiceStatus(params, clientKind ? 'relay' : 'runtime')
  }),
  defineMethod({
    name: 'aiVault.setSearchEnabled',
    permission: 'settings-write',
    params: AiVaultSetSearchEnabledParamsSchema,
    handler: async (params, { runtime, clientKind, pairedDeviceId }) => {
      // Paired clients only: an in-process caller writes this host's own settings directly,
      // and admitting one here would let any unauthenticated local path flip consent.
      if (!pairedDeviceId) {
        throw Object.assign(
          new Error('Session search consent can only be changed by a paired client.'),
          { code: 'forbidden' }
        )
      }
      await runtime.setSessionSearchEnabled(params.enabled)
      console.warn(
        `[ai-vault-search] device ${pairedDeviceId} set indexing enabled=${params.enabled}`
      )
      return sessionSearchServiceStatus({}, clientKind ? 'relay' : 'runtime')
    }
  }),
  defineMethod({
    name: 'aiVault.resolveSessionTitles',
    permission: 'workspace',
    params: AiVaultSessionTitlesParams,
    handler: (params, { runtime, signal }) =>
      runtime.resolveAiVaultSessionTitles(params.requests, signal)
  }),
  defineMethod({
    name: 'aiVault.listSessions',
    permission: 'workspace',
    params: AiVaultListSessionsParams,
    handler: async (params, { runtime, clientKind, clientCapabilities }) => {
      await ensureStructuredAgentSessionHostUnlessRefused(() =>
        runtime.ensureStructuredAgentSessionHost()
      )
      let result
      try {
        result = await runtime.listAiVaultSessions({
          limit: params.unlimited ? undefined : params.limit,
          unlimited: params.unlimited,
          force: params.force,
          scopePaths: params.scopePaths,
          includeAntigravityIdeSessions: params.includeAntigravityIdeSessions
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
      const projected = projectStructuredAiVaultSessions(result, (agent) =>
        clientOpensStructuredChatFromHistory({ clientKind, clientCapabilities }, agent)
      )
      return params.executionHostId
        ? restampAiVaultListResult(projected, params.executionHostId)
        : projected
    }
  }),
  defineMethod({
    name: 'aiVault.prepareSessionResume',
    permission: 'workspace',
    params: AiVaultPrepareSessionResumeParams,
    handler: async (params, { runtime }) => {
      const args: AiVaultPrepareSessionResumeArgs = {
        agent: params.agent,
        ...(params.sessionId ? { sessionId: params.sessionId } : {}),
        ...(params.fork ? { fork: true } : {}),
        filePath: params.filePath,
        codexHome: params.codexHome,
        // Why: the RPC executes on the transcript-owning host; never let a
        // client-provided runtime/SSH stamp escape that host boundary.
        executionHostId: LOCAL_EXECUTION_HOST_ID
      }
      await ensureStructuredAgentSessionHostUnlessRefused(() =>
        runtime.ensureStructuredAgentSessionHost()
      )
      assertLegacyAiVaultResumeAllowed(args)
      return runtime.prepareAiVaultSessionResume(args)
    }
  })
]
