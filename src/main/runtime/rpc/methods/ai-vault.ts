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
import { LOCAL_EXECUTION_HOST_ID, parseExecutionHostId } from '../../../../shared/execution-host'
import { describeAiVaultScanError } from '../../../../shared/ai-vault-scan-error-message'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import {
  assertLegacyAiVaultResumeAllowed,
  projectStructuredAiVaultSessions,
  searchWithStructuredOwners
} from '../../../ai-vault/structured-session-ownership'
import { ensureStructuredAgentSessionHostUnlessRefused } from '../../structured-agent-session-host-refusal'
import {
  isActiveSshAiVaultTarget,
  probeWslTranscriptOnSshHost
} from '../../../host/ai-vault-ssh-host-port'
import {
  AiVaultListSessionsParams,
  AiVaultPrepareSessionResumeParams,
  AiVaultProbeSessionTranscriptParams,
  AiVaultSessionTitlesParams
} from '../../../../shared/rpc-contract/ai-vault-params'
export {
  AiVaultListSessionsParams,
  AiVaultPrepareSessionResumeParams,
  AiVaultProbeSessionTranscriptParams,
  AiVaultSessionTitlesParams
}

export const AI_VAULT_METHODS = [
  defineMethod({
    name: 'aiVault.searchSessions',
    permission: 'workspace',
    params: AiVaultSearchRequestSchema,
    handler: (params, { runtime, clientKind, clientCapabilities }) => {
      const response = searchSessionService(params, clientKind ? 'relay' : 'runtime')
      // A client that cannot open the native owner keeps the transcript hit, as before.
      return clientKind === undefined ||
        clientCapabilities?.includes(STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY)
        ? searchWithStructuredOwners(response, () => runtime.ensureStructuredAgentSessionHost())
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
      const sshScoped = parseExecutionHostId(params.executionHostScope)?.kind === 'ssh'
      let result
      try {
        result = await runtime.listAiVaultSessions({
          limit: params.unlimited ? undefined : params.limit,
          unlimited: params.unlimited,
          force: params.force,
          scopePaths: params.scopePaths,
          includeAntigravityIdeSessions: params.includeAntigravityIdeSessions,
          ...(params.executionHostScope ? { executionHostScope: params.executionHostScope } : {})
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
      const projected = projectStructuredAiVaultSessions(
        result,
        clientKind === undefined ||
          (clientCapabilities?.includes(STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY) ?? false)
      )
      // Why: an SSH-scoped scan already carries its own host stamp; restamping it as a
      // runtime host would make same-host rows look foreign.
      return params.executionHostId && !sshScoped
        ? restampAiVaultListResult(projected, params.executionHostId)
        : projected
    }
  }),
  defineMethod({
    name: 'aiVault.prepareSessionResume',
    permission: 'workspace',
    params: AiVaultPrepareSessionResumeParams,
    handler: async (params, { runtime }) => {
      // Why: a stamp naming an SSH target this host is connected to is the one stamp honored,
      // so the host never materializes a remote transcript path against its own disk.
      // Anything else (unknown target, runtime id, garbage) stays host-local.
      const sshHost = parseExecutionHostId(params.executionHostId)
      const sshStamp =
        sshHost?.kind === 'ssh' && isActiveSshAiVaultTarget(sshHost.targetId) ? sshHost.id : null
      const args: AiVaultPrepareSessionResumeArgs = {
        agent: params.agent,
        ...(params.sessionId ? { sessionId: params.sessionId } : {}),
        ...(params.fork ? { fork: true } : {}),
        filePath: params.filePath,
        codexHome: params.codexHome,
        // Why: the RPC executes on the transcript-owning host; never let a
        // client-provided runtime/SSH stamp escape that host boundary.
        executionHostId: sshStamp ?? LOCAL_EXECUTION_HOST_ID
      }
      await ensureStructuredAgentSessionHostUnlessRefused(() =>
        runtime.ensureStructuredAgentSessionHost()
      )
      assertLegacyAiVaultResumeAllowed(args)
      // Why: like desktop, an SSH host's transcript needs no local home preparation.
      return sshStamp ? { useRealCodexHome: false } : runtime.prepareAiVaultSessionResume(args)
    }
  }),
  defineMethod({
    name: 'aiVault.probeSessionTranscript',
    permission: 'workspace',
    params: AiVaultProbeSessionTranscriptParams,
    handler: async (params) => ({
      status: await probeWslTranscriptOnSshHost(
        parseSshTargetId(params.executionHostId),
        params.filePath
      )
    })
  })
]

function parseSshTargetId(executionHostId: `ssh:${string}`): string {
  const parsed = parseExecutionHostId(executionHostId)
  if (parsed?.kind !== 'ssh') {
    throw new Error('Invalid SSH execution host id')
  }
  return parsed.targetId
}
