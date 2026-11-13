// Orca account agent credentials on the sandbox control plane (contract D11 + §2). Write-only for the
// Claude token: the PUT carries it, no response or error does, and nothing here logs a body.
import { z } from 'zod'
import {
  AgentCredentialsResponseSchema,
  AgentSourcesResponseSchema,
  CodexBrokerStartResponseSchema,
  CodexBrokerStatusResponseSchema,
  type AgentCredentialsView,
  type AgentSource,
  type AgentSourcesView,
  type CodexBrokerStart,
  type CodexBrokerStatus,
  type OrcaCloudAccountAgent,
  type OrcaCloudAgentsErrorCode
} from '../../shared/orca-cloud-agents/orca-cloud-agents-wire'
import { isEnvironmentProviderError } from '../environment-providers/environment-provider-driver'
import {
  HostedSandboxRefusalError,
  createHostedSandboxRequest,
  type HostedSandboxControlPlaneClientOptions
} from '../hosted-sandbox/hosted-sandbox-request'

export type AgentCredentialsClient = {
  credentials(signal?: AbortSignal): Promise<AgentCredentialsView>
  /** With a workspaceId (sandbox id), `effective` and `sharedWorkspace` describe that workspace. */
  sources(signal?: AbortSignal, workspaceId?: string): Promise<AgentSourcesView>
  /** Main only, right after setup-token on this computer or a paste. */
  putClaude(token: string, label?: string): Promise<AgentCredentialsView>
  remove(agent: OrcaCloudAccountAgent): Promise<AgentCredentialsView>
  setDefaultSource(agent: OrcaCloudAccountAgent, source: AgentSource): Promise<AgentSourcesView>
  /** The Source for one workspace (sandbox id); the reply describes that workspace. */
  setWorkspaceSource(
    agent: OrcaCloudAccountAgent,
    source: AgentSource,
    workspaceId: string
  ): Promise<AgentSourcesView>
  startCodexBroker(): Promise<CodexBrokerStart>
  codexBrokerStatus(brokerId: string): Promise<CodexBrokerStatus>
  cancelCodexBroker(brokerId: string): Promise<void>
}

const CancelResponse = z.looseObject({})
// Leading letter or digit: '.' and '..' would resolve to another path.
const BROKER_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/

function brokerPath(brokerId: string): string {
  if (!BROKER_ID.test(brokerId)) {
    throw new Error('Invalid broker id.')
  }
  return `v1/agent-credentials/codex/broker/${encodeURIComponent(brokerId)}`
}

export function createAgentCredentialsClient(
  options: HostedSandboxControlPlaneClientOptions
): AgentCredentialsClient {
  const call = createHostedSandboxRequest(options)
  return {
    credentials: (signal) =>
      call('GET', 'v1/agent-credentials', AgentCredentialsResponseSchema, {
        kind: 'control',
        signal
      }),
    sources: (signal, workspaceId) =>
      call(
        'GET',
        workspaceId
          ? `v1/agent-sources?${new URLSearchParams({ workspaceId })}`
          : 'v1/agent-sources',
        AgentSourcesResponseSchema,
        { kind: 'control', signal }
      ),
    putClaude: (token, label) =>
      call('PUT', 'v1/agent-credentials/claude', AgentCredentialsResponseSchema, {
        body: label ? { token, label } : { token },
        kind: 'control'
      }),
    remove: (agent) =>
      call('DELETE', `v1/agent-credentials/${agent}`, AgentCredentialsResponseSchema, {
        kind: 'control'
      }),
    setDefaultSource: (agent, source) =>
      call('PUT', 'v1/agent-sources', AgentSourcesResponseSchema, {
        body: { agent, source },
        kind: 'control'
      }),
    setWorkspaceSource: (agent, source, workspaceId) =>
      call('PUT', 'v1/agent-sources', AgentSourcesResponseSchema, {
        body: { agent, source, workspaceId },
        kind: 'control'
      }),
    startCodexBroker: () =>
      call('POST', 'v1/agent-credentials/codex/broker', CodexBrokerStartResponseSchema, {
        body: {},
        // The broker boots a sandbox before it can print a device code.
        kind: 'boot'
      }),
    codexBrokerStatus: async (brokerId) =>
      call('GET', brokerPath(brokerId), CodexBrokerStatusResponseSchema, { kind: 'control' }),
    cancelCodexBroker: async (brokerId) => {
      await call('DELETE', brokerPath(brokerId), CancelResponse, { kind: 'control' })
    }
  }
}

const SERVER_CODES = new Map<string, OrcaCloudAgentsErrorCode>([
  ['broker_in_progress', 'broker_in_progress'],
  ['rate_limited', 'rate_limited'],
  ['broker_unavailable', 'broker_unavailable'],
  ['device_auth_disabled', 'device_auth_disabled'],
  ['no_golden_image', 'no_golden_image'],
  ['not_configured', 'not_configured']
])

/** The code the renderer turns into copy. Never the error's message. */
export function agentCredentialsFailureCode(error: unknown): OrcaCloudAgentsErrorCode {
  if (!isEnvironmentProviderError(error)) {
    return 'unknown'
  }
  const serverError = error instanceof HostedSandboxRefusalError ? error.serverError : null
  const named = serverError ? SERVER_CODES.get(serverError) : undefined
  if (named) {
    return named
  }
  switch (error.code) {
    case 'unauthorized':
      return 'signed_out'
    case 'not_found':
      // The credential routes answer 404 while the provider is off (flag or kill switch).
      return 'not_found'
    case 'invalid_request':
      return error.reason === 'invalid_token' ? 'invalid_token' : 'unknown'
    case 'timeout':
      return 'timeout'
    case 'conflict':
    case 'unavailable':
    case 'aborted':
    case 'invalid_response':
      return 'unavailable'
  }
}
