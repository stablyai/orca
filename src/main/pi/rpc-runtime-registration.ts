import type {
  StructuredAgentAdapterContext,
  StructuredAgentRuntimeAdapter,
  StructuredAgentRuntimeRegistration
} from '../runtime/agent-session/installation/structured-agent-runtime-registration-types'
import {
  composeStructuredLaunch,
  structuredAgentLaunchSources
} from '../runtime/agent-session/launch/structured-agent-launch-composition'
import { PI_RPC_AGENT } from './rpc-agent-definition'
import type { DirectoryAccountAgentDefinition } from '../native-chat/agent-session-wire/providers/structured-agent-definition'
import { PI_RPC_FAMILY_PI, type PiRpcFamily } from './rpc/pi-rpc-family'
import { piRpcLaunchPart } from './rpc/launch/rpc-launch-resolution'
import { PiRpcSessionAdapter } from './rpc/rpc-session-adapter'
import { PI_RPC_RUNTIME_METADATA } from './rpc-runtime-metadata'

export function createPiRpcAdapter(
  context: StructuredAgentAdapterContext,
  family: PiRpcFamily = PI_RPC_FAMILY_PI,
  definition: DirectoryAccountAgentDefinition = PI_RPC_AGENT
): StructuredAgentRuntimeAdapter {
  const { deps } = context
  return new PiRpcSessionAdapter({
    family,
    resolveLaunch:
      (family.agent === 'pi' ? deps.resolvePiLaunch : undefined) ??
      composeStructuredLaunch(
        definition,
        structuredAgentLaunchSources(context),
        piRpcLaunchPart({
          family,
          logger: deps.logger,
          dataDirectory: deps.stateDirectory,
          managedExtensionsEnabled: deps.piManagedExtensionsEnabled
        })
      ),
    ...(deps.openPiConnection ? { openConnection: deps.openPiConnection } : {}),
    ...(deps.readProcessStartTime ? { readProcessStartTime: deps.readProcessStartTime } : {}),
    onLifecycle: context.deliverLifecycle,
    onChildWorkEvidence: (sessionId, evidence, producer) =>
      context.host()?.publishChildWorkEvidence(sessionId, evidence, producer),
    onSettled: ({ sessionId, clientMessageId, outcome }) => {
      if (outcome.state === 'admitted') {
        return
      }
      context.followUps.onDispatchSettledLate({
        sessionId,
        clientMessageId,
        ...(outcome.state === 'accepted'
          ? {
              providerIdentity: outcome.providerIdentity,
              ...(outcome.answeredInTurn ? { answeredInTurn: outcome.answeredInTurn } : {})
            }
          : outcome)
      })
    },
    persistResumePoint: async ({ sessionId, fence, handle }) => {
      await context.store.updateRecord(sessionId, {
        kind: 'resume-point',
        args: { fence, handle, now: Date.now() }
      })
    },
    logger: deps.logger
  })
}

export const PI_RPC_RUNTIME_REGISTRATION: StructuredAgentRuntimeRegistration = Object.assign(
  PI_RPC_RUNTIME_METADATA,
  { createAdapter: (context) => createPiRpcAdapter(context) }
)
