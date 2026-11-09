import { ensureAgentSessionFeatureRequirement } from '../../agent-launch-feature-requirement'
import { terminalImageViewerSupported } from '../../../terminal/launch/terminal-image-viewer-env'
import {
  type RuntimeAgentSessionRpcCaller,
  AGENT_SESSION_OPERATION_FUTURE_SKEW_MS,
  parseAgentSessionOperationTimestamp
} from '../../../../../shared/agent-session/agent-session-host-authority'
import { defineMethod, type RpcContext } from '../../core'
import {
  CreateAgentSessionParams,
  EnsureAgentSessionParams
} from '../../../../../shared/rpc-contract/agent-session-params'
import { withAgentKeyLaunchEnv } from '../../../../../shared/agent-api-keys/agent-key-launch-env'

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

/** Carried keys ride the account env the launch already merges over its plan; nothing downstream keeps the request. */
function withKeyEnvFolded<
  T extends { accountEnv?: Record<string, string>; keyEnv?: Record<string, string> }
>(params: T): T {
  if (!params.keyEnv) {
    return params
  }
  const { keyEnv, ...rest } = params
  const accountEnv = withAgentKeyLaunchEnv(rest.accountEnv, keyEnv)
  return { ...rest, ...(accountEnv ? { accountEnv } : {}) } as T
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
    requires: ensureAgentSessionFeatureRequirement,
    permission: 'workspace',
    params: EnsureAgentSessionParams,
    handler: (params, context) =>
      context.runtime.ensureAgentSession(
        withExecutionHostAgentPresentation(
          params.kind === 'explicit' ? withKeyEnvFolded(params) : params,
          context.clientKind
        ),
        callerContext(context)
      )
  }),
  defineMethod({
    name: 'terminal.createAgentSession',
    requires: ['accounts'],
    permission: 'workspace',
    params: CreateAgentSessionParams,
    handler: (params, context) => {
      assertOperationTimestampWithinFutureSkew(params.clientOperationId)
      return context.runtime.createAgentSession(
        withExecutionHostAgentPresentation(withKeyEnvFolded(params), context.clientKind),
        callerContext(context)
      )
    }
  })
]
