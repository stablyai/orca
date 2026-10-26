import { terminalImageViewerSupported } from '../../terminal-image-viewer-env'
import type { RuntimeAgentSessionRpcCaller } from '../../../../shared/agent-session-host-authority'
import {
  AGENT_SESSION_OPERATION_FUTURE_SKEW_MS,
  parseAgentSessionOperationTimestamp
} from '../../../../shared/agent-session-host-authority'
import { defineMethod, type RpcContext } from '../core'
import {
  CreateAgentSessionParams,
  EnsureAgentSessionParams
} from '../../../../shared/rpc-contract/agent-session-params'
export { CreateAgentSessionParams, EnsureAgentSessionParams }

function callerContext(context: RpcContext): RuntimeAgentSessionRpcCaller {
  const { pairedDeviceId, clientId, clientKind, signal } = context
  const viewerSupported = terminalImageViewerSupported(context)
  return {
    ...((pairedDeviceId ?? clientId) !== undefined ? { clientId: pairedDeviceId ?? clientId } : {}),
    ...(clientKind !== undefined ? { clientKind } : {}),
    ...(signal ? { signal } : {}),
    ...(viewerSupported !== undefined ? { terminalImageViewerSupported: viewerSupported } : {})
  }
}

function withExecutionHostAgentPresentation<T extends { presentation?: 'background' | 'focused' }>(
  params: T,
  clientKind: 'mobile' | 'runtime' | undefined
): T {
  // Paired viewers focus their own mirror; the execution host may have no renderer.
  return clientKind && params.presentation === 'focused'
    ? { ...params, presentation: 'background' }
    : params
}

function assertOperationTimestampWithinFutureSkew(clientOperationId: string): void {
  const timestamp = parseAgentSessionOperationTimestamp(clientOperationId)
  if (timestamp === null || timestamp > Date.now() + AGENT_SESSION_OPERATION_FUTURE_SKEW_MS) {
    // Reject future ids that could appear new after tombstone collection.
    throw new Error('agent_session_operation_invalid')
  }
}

export const AGENT_SESSION_METHODS = [
  defineMethod({
    name: 'terminal.ensureAgentSession',
    permission: 'workspace',
    params: EnsureAgentSessionParams,
    handler: (params, context) =>
      context.runtime.ensureAgentSession(
        withExecutionHostAgentPresentation(params, context.clientKind),
        callerContext(context)
      )
  }),
  defineMethod({
    name: 'terminal.createAgentSession',
    permission: 'workspace',
    params: CreateAgentSessionParams,
    handler: (params, context) => {
      assertOperationTimestampWithinFutureSkew(params.clientOperationId)
      return context.runtime.createAgentSession(
        withExecutionHostAgentPresentation(params, context.clientKind),
        callerContext(context)
      )
    }
  })
]
