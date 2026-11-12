import { prepareStructuredChatCliFork } from '../../../../ai-vault/structured-sessions/structured-chat-cli-fork'
import { writeAiVaultSessionHandoffSnapshot } from '../../../../ai-vault/session-handoff-snapshot'
import {
  AiVaultSearchRequestSchema,
  AiVaultSearchStatusRequestSchema,
  AiVaultSetSearchEnabledParamsSchema
} from '../../../../../shared/ai-vault/search/ai-vault-search-contract'
import { sessionSearchTransportForClient } from '../../../../../shared/ai-vault/search/ai-vault-search-transport'
import {
  searchSessionService,
  sessionSearchServiceStatus
} from '../../../../ai-vault-search/session-search-service-registry'
import { defineMethod } from '../../core'
import { conditionalAiVaultListResult } from '../../../../ai-vault/listing/session-list-fingerprint'
import { restampAiVaultListResult } from '../../../../ai-vault/listing/session-list-results'
import { copyStructuredChatConversation } from '../../../../ai-vault/structured-sessions/structured-chat-conversation-copy'
import type { AiVaultPrepareSessionResumeArgs } from '../../../../../shared/ai-vault/resume/ai-vault-resume-preparation'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host'
import { isWslUncPath } from '../../../../../shared/wsl-paths'
import { describeAiVaultScanError } from '../../../../../shared/ai-vault/scanning/ai-vault-scan-error-message'
import {
  assertLegacyAiVaultResumeAllowed,
  projectStructuredAiVaultSessions,
  searchWithStructuredOwners
} from '../../../../ai-vault/structured-sessions/structured-session-ownership'
import {
  ensureStructuredAgentSessionHostUnlessRefused,
  tryEnsureStructuredAgentSessionHostForResume
} from '../../../agent-session/structured-agent-session-host-refusal'
import {
  clientOpensStructuredChatFromHistory,
  supportsStructuredAgentSessions
} from '../structured-sessions/structured-agent-session-policy'
import {
  AiVaultDeleteSessionParams,
  AiVaultListSessionsParams,
  AiVaultPrepareSessionHandoffParams,
  AiVaultPrepareSessionResumeParams,
  AiVaultSessionTitlesParams
} from '../../../../../shared/rpc-contract/ai-vault-params'

export const AI_VAULT_METHODS = [
  defineMethod({
    name: 'aiVault.searchSessions',
    requires: ['sessionSearch'],
    permission: 'workspace',
    params: AiVaultSearchRequestSchema,
    handler: (params, context) => {
      const transport = sessionSearchTransportForClient(context.clientKind)
      const response = searchSessionService(params, transport)
      // A client that reads no structured sessions keeps the transcript hit, as before.
      return supportsStructuredAgentSessions(context)
        ? searchWithStructuredOwners(response, {
            ensureHost: () => context.runtime.ensureStructuredAgentSessionHost(),
            transport,
            opensChat: (agent) => clientOpensStructuredChatFromHistory(context, agent)
          })
        : response
    }
  }),
  defineMethod({
    name: 'aiVault.searchStatus',
    requires: ['sessionSearch'],
    permission: 'workspace',
    params: AiVaultSearchStatusRequestSchema,
    handler: (params, { clientKind }) =>
      sessionSearchServiceStatus(params, sessionSearchTransportForClient(clientKind))
  }),
  defineMethod({
    name: 'aiVault.setSearchEnabled',
    requires: ['sessionSearch'],
    permission: 'settings-write',
    params: AiVaultSetSearchEnabledParamsSchema,
    handler: async (params, { runtime, clientKind, pairedDeviceId }) => {
      // Only authenticated paired clients may flip host consent; local callers write settings directly.
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
      return sessionSearchServiceStatus({}, sessionSearchTransportForClient(clientKind))
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
    handler: async (params, { runtime, clientKind, clientCapabilities, signal }) => {
      await ensureStructuredAgentSessionHostUnlessRefused(() =>
        runtime.ensureStructuredAgentSessionHost()
      )
      let result
      try {
        result = await runtime.listAiVaultSessions(
          {
            limit: params.unlimited ? undefined : params.limit,
            unlimited: params.unlimited,
            force: params.force,
            scopePaths: params.scopePaths,
            scopeOnly: params.scopeOnly,
            includeAntigravityIdeSessions: params.includeAntigravityIdeSessions
          },
          signal
        )
      } catch (error) {
        if (error instanceof Error) {
          error.message = describeAiVaultScanError(error.message)
          throw error
        }
        throw new Error(describeAiVaultScanError(String(error)))
      }
      // Web clients have no parent retagging, so stamp sessions with the runtime host they addressed.
      const projected = projectStructuredAiVaultSessions(result, (agent) =>
        clientOpensStructuredChatFromHistory({ clientKind, clientCapabilities }, agent)
      )
      return conditionalAiVaultListResult(
        params.executionHostId
          ? restampAiVaultListResult(projected, params.executionHostId)
          : projected,
        params.unlimited ? undefined : params.afterFingerprint,
        params.force
      )
    }
  }),
  defineMethod({
    name: 'aiVault.prepareSessionResume',
    permission: 'workspace',
    params: AiVaultPrepareSessionResumeParams,
    handler: async (params, { runtime }) => {
      if ('sourceChat' in params) {
        await runtime.ensureStructuredAgentSessionHost()
        return prepareStructuredChatCliFork(params, (args) =>
          runtime.prepareAiVaultSessionResume(args)
        )
      }
      const args: AiVaultPrepareSessionResumeArgs = {
        agent: params.agent,
        ...(params.sessionId ? { sessionId: params.sessionId } : {}),
        ...(params.fork ? { fork: true } : {}),
        filePath: params.filePath,
        codexHome: params.codexHome,
        // This host owns the transcripts; never echo a client-supplied runtime/SSH owner stamp.
        executionHostId: LOCAL_EXECUTION_HOST_ID
      }
      if (!isWslUncPath(args.filePath)) {
        const ensureHost = () => runtime.ensureStructuredAgentSessionHost()
        await (args.codexHome === null && !args.fork
          ? tryEnsureStructuredAgentSessionHostForResume(ensureHost)
          : ensureStructuredAgentSessionHostUnlessRefused(ensureHost))
        assertLegacyAiVaultResumeAllowed(args)
      }
      return (
        (await copyStructuredChatConversation(args)) ?? runtime.prepareAiVaultSessionResume(args)
      )
    }
  }),
  defineMethod({
    name: 'aiVault.prepareSessionHandoff',
    permission: 'workspace',
    params: AiVaultPrepareSessionHandoffParams,
    handler: (params) => writeAiVaultSessionHandoffSnapshot(params)
  }),
  defineMethod({
    name: 'aiVault.deleteSession',
    permission: 'workspace',
    params: AiVaultDeleteSessionParams,
    handler: (params, { runtime }) => runtime.deleteAiVaultSession(params)
  })
]
