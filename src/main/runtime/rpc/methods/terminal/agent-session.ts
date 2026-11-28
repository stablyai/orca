import { ensureAgentSessionFeatureRequirement } from '../../startup/agent-launch-feature-requirement'
import { terminalImageViewerSupported } from '../../../terminal/launch/terminal-image-viewer-env'
import {
  type RuntimeAgentSessionRpcCaller,
  AGENT_SESSION_OPERATION_FUTURE_SKEW_MS,
  parseAgentSessionOperationTimestamp
} from '../../../../../shared/agent-session/lifecycle/operations/agent-session-host-authority'
import { defineMethod, type RpcContext } from '../../core'
import {
  CreateAgentSessionParams,
  EnsureAgentSessionParams
} from '../../../../../shared/rpc-contract/terminal/agent-session-params'

async function callerContext(
  context: RpcContext,
  worktree: string | undefined
): Promise<RuntimeAgentSessionRpcCaller> {
  const { pairedDeviceId, clientId, clientKind, signal } = context
  const viewerSupported = terminalImageViewerSupported(context)
  const holder = await context.runtime.tabListHolderOf(worktree, context.callerScope)
  return {
    ...(holder ? { holder } : {}),
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
    requires: ensureAgentSessionFeatureRequirement,
    permission: 'workspace',
    share: 'not-shared',
    params: EnsureAgentSessionParams,
    handler: async (params, context) =>
      context.runtime.ensureAgentSession(
        withExecutionHostAgentPresentation(params, context.clientKind),
        await callerContext(context, 'worktree' in params ? params.worktree : undefined)
      )
  }),
  defineMethod({
    name: 'terminal.createAgentSession',
    requires: ['accounts'],
    permission: 'workspace',
    share: 'not-shared',
    params: CreateAgentSessionParams,
    handler: async (params, context) => {
      assertOperationTimestampWithinFutureSkew(params.clientOperationId)
      return context.runtime.createAgentSession(
        withExecutionHostAgentPresentation(params, context.clientKind),
        await callerContext(context, params.worktree)
      )
    }
  })
]
