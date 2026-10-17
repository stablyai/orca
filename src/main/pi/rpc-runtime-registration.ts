import type {
  StructuredAgentAdapterContext,
  StructuredAgentRuntimeAdapter,
  StructuredAgentRuntimeRegistration
} from '../runtime/structured-agent-runtime-registration-types'
import {
  composeStructuredLaunch,
  structuredAgentLaunchSources
} from '../runtime/structured-agent-launch-composition'
import { PI_RPC_AGENT } from './rpc-agent-definition'
import { piRpcLaunchPart } from './rpc-launch-resolution'
import { PiRpcSessionAdapter } from './rpc-session-adapter'
import { PI_RPC_RUNTIME_METADATA } from './rpc-runtime-metadata'

function createPiRpcAdapter(context: StructuredAgentAdapterContext): StructuredAgentRuntimeAdapter {
  const { deps } = context
  return new PiRpcSessionAdapter({
    resolveLaunch:
      deps.resolvePiLaunch ??
      composeStructuredLaunch(
        PI_RPC_AGENT,
        structuredAgentLaunchSources(context),
        piRpcLaunchPart({})
      ),
    ...(deps.openPiConnection ? { openConnection: deps.openPiConnection } : {}),
    ...(deps.readProcessStartTime ? { readProcessStartTime: deps.readProcessStartTime } : {}),
    onLifecycle: context.deliverLifecycle,
    onSettled: ({ sessionId, clientMessageId, outcome }) => {
      if (outcome.state === 'admitted') {
        return
      }
      context.followUps.onDispatchSettledLate({
        sessionId,
        clientMessageId,
        ...(outcome.state === 'accepted' ? { providerIdentity: outcome.providerIdentity } : outcome)
      })
    },
    onIdle: context.followUps.releaseUnansweredDispatches,
    logger: deps.logger
  })
}

export const PI_RPC_RUNTIME_REGISTRATION: StructuredAgentRuntimeRegistration = Object.assign(
  PI_RPC_RUNTIME_METADATA,
  { createAdapter: createPiRpcAdapter }
)
