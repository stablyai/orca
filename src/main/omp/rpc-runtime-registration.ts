import type {
  StructuredAgentAdapterContext,
  StructuredAgentRuntimeAdapter
} from '../runtime/structured-agent-runtime-registration-types'
import {
  composeStructuredLaunch,
  structuredAgentLaunchSources
} from '../runtime/structured-agent-launch-composition'
import { reviseAgentSessionProviderResumePoint } from '../runtime/agent-session/ownership/agent-session-provider-handle-transition'
import { OMP_RPC_AGENT } from './rpc-agent-definition'
import { ompRpcLaunchPart } from './rpc-launch'
import { OmpRpcSessionAdapter } from './rpc-session-adapter'
import { createOmpRpcAtRestCommands } from './rpc-at-rest-commands'

export function createOmpRpcAdapter(
  context: StructuredAgentAdapterContext
): StructuredAgentRuntimeAdapter {
  return new OmpRpcSessionAdapter({
    atRestCommands: createOmpRpcAtRestCommands(context),
    resolveLaunch: composeStructuredLaunch(
      OMP_RPC_AGENT,
      structuredAgentLaunchSources(context),
      ompRpcLaunchPart(context.deps.stateDirectory)
    ),
    onLifecycle: context.deliverLifecycle,
    onChildWorkEvidence: (sessionId, evidence, producer) =>
      context.host()?.publishChildWorkEvidence(sessionId, evidence, producer),
    onSettled: ({ sessionId, clientMessageId, outcome }) => {
      if (outcome.state !== 'admitted') {
        context.followUps.onDispatchSettledLate({
          sessionId,
          clientMessageId,
          ...(outcome.state === 'accepted'
            ? { providerIdentity: outcome.providerIdentity }
            : outcome)
        })
      }
    },
    persistResumePoint: async ({ sessionId, fence, handle }) => {
      await context.store.transitionHandoff(sessionId, (record) =>
        reviseAgentSessionProviderResumePoint({ record, fence, handle, now: Date.now() })
      )
    },
    ...(context.deps.readProcessStartTime
      ? { readProcessStartTime: context.deps.readProcessStartTime }
      : {}),
    logger: context.deps.logger
  })
}
