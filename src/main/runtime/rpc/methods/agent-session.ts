import type {
  RuntimeAgentSessionRpcCaller,
  RuntimeCreateAgentSessionRequest,
  RuntimeCreateAgentSessionResult,
  RuntimeEnsureAgentSessionRequest,
  RuntimeEnsureAgentSessionResult
} from '../../../../shared/agent-session-host-authority'
import {
  AGENT_SESSION_OPERATION_FUTURE_SKEW_MS,
  parseAgentSessionOperationTimestamp
} from '../../../../shared/agent-session-host-authority'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { defineMethod } from '../core'
import {
  CreateAgentSessionParams,
  EnsureAgentSessionParams
} from '../../../../shared/rpc-contract/agent-session-params'
import {
  agentSessionConversationRoot,
  assertExplicitResumeConversationUnowned,
  withAgentSessionConversationGate
} from './agent-session-explicit-resume-hold'
export { CreateAgentSessionParams, EnsureAgentSessionParams }

type AgentSessionRuntime = OrcaRuntimeService & {
  ensureStructuredAgentSessionHost(): Promise<void>
  ensureAgentSession(
    request: RuntimeEnsureAgentSessionRequest,
    caller?: RuntimeAgentSessionRpcCaller
  ): Promise<RuntimeEnsureAgentSessionResult>
  createAgentSession(
    request: RuntimeCreateAgentSessionRequest,
    caller?: RuntimeAgentSessionRpcCaller
  ): Promise<RuntimeCreateAgentSessionResult>
}

function callerContext(
  clientId: string | undefined,
  clientKind: 'mobile' | 'runtime' | undefined,
  signal: AbortSignal | undefined
): RuntimeAgentSessionRpcCaller {
  return {
    ...(clientId !== undefined ? { clientId } : {}),
    ...(clientKind !== undefined ? { clientKind } : {}),
    ...(signal ? { signal } : {})
  }
}

function withExecutionHostAgentPresentation<T extends { presentation?: 'background' | 'focused' }>(
  params: T,
  clientKind: 'mobile' | 'runtime' | undefined
): T {
  // Why: paired viewers focus their own mirror; the execution host may have no renderer.
  return clientKind && params.presentation === 'focused'
    ? { ...params, presentation: 'background' }
    : params
}

function assertOperationTimestampWithinFutureSkew(clientOperationId: string): void {
  const timestamp = parseAgentSessionOperationTimestamp(clientOperationId)
  if (timestamp === null || timestamp > Date.now() + AGENT_SESSION_OPERATION_FUTURE_SKEW_MS) {
    // Why: a future-dated ID could look new again after its idempotency tombstone is collected.
    throw new Error('agent_session_operation_invalid')
  }
}

export const AGENT_SESSION_METHODS = [
  defineMethod({
    name: 'terminal.ensureAgentSession',
    params: EnsureAgentSessionParams,
    handler: async (params, { runtime, pairedDeviceId, clientId, clientKind, signal }) => {
      const root = agentSessionConversationRoot(params)
      if (root !== null && getStructuredAgentSessionHost() === null) {
        await runtime.ensureStructuredAgentSessionHost()
      }
      return withAgentSessionConversationGate(root, async () => {
        assertExplicitResumeConversationUnowned(params, getStructuredAgentSessionHost())
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the dispatcher hands every method the same runtime service, which implements this interface (as below).
        return await (runtime as AgentSessionRuntime).ensureAgentSession(
          withExecutionHostAgentPresentation(params, clientKind),
          callerContext(pairedDeviceId ?? clientId, clientKind, signal)
        )
      })
    }
  }),
  defineMethod({
    name: 'terminal.createAgentSession',
    params: CreateAgentSessionParams,
    handler: (params, { runtime, pairedDeviceId, clientId, clientKind, signal }) => {
      assertOperationTimestampWithinFutureSkew(params.clientOperationId)
      return (runtime as AgentSessionRuntime).createAgentSession(
        withExecutionHostAgentPresentation(params, clientKind),
        callerContext(pairedDeviceId ?? clientId, clientKind, signal)
      )
    }
  })
]
