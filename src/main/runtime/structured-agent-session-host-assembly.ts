// Loaded on first host install: the host, router and every provider adapter stay out of startup.

import { bindAtRestCommandContexts } from '../native-chat/agent-session-wire/at-rest-command-context'
import { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { StructuredAgentSessionAdapterRouter } from '../native-chat/agent-session-wire/structured-agent-session-adapter-router'
import { StructuredAgentRegistry } from '../native-chat/agent-session-wire/structured-agent-registry'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { scheduleNativeChatVisualsSweep } from '../native-chat/native-chat-visuals-sweep'
import type { InstalledRuntime } from './agent-session/structured-agent-session-runtime-teardown'
import { AgentSessionRecoveryCapsule } from './agent-session-recovery-capsule'
import type { OpenedAgentSessionRecordStore } from './agent-session-record-store-slot'
import { installAgentSessionAttachments } from './structured-agent-session-attachment-wiring'
import {
  createStructuredAgentSessionOwnerProbe,
  createStructuredAgentSessionOwnerProbes
} from './structured-agent-session-owner-probe'
import { createStructuredAgentEnvironmentResolvers } from './structured-agent-shell-environment'
import type { StructuredAgentAdapterContext } from './structured-agent-runtime-registration-types'
import { STRUCTURED_AGENT_RUNTIME_REGISTRATIONS } from './structured-agent-runtime-registrations'
import { createStructuredAgentSessionLifecycleDelivery } from './structured-agent-session-lifecycle-delivery'
import { createStructuredAgentSessionDispatchFollowUps } from './structured-agent-session-dispatch-followups'
import { modelCatalogHostDeps } from './structured-agent-model-catalog-wiring'
import type { StructuredAgentSessionRuntimeDeps } from './structured-agent-session-runtime'

export async function installOnJournal(
  deps: StructuredAgentSessionRuntimeDeps,
  { journalDatabase, store }: OpenedAgentSessionRecordStore
): Promise<InstalledRuntime> {
  const envResolvers = createStructuredAgentEnvironmentResolvers(deps)
  let host: StructuredAgentSessionHost | null = null
  const lifecycle = createStructuredAgentSessionLifecycleDelivery({
    handle: (event) => host?.handleAdapterEvent(event),
    logger: deps.logger,
    // An agent that publishes an observed exit only after its own close work drains it here.
    drainObservedExits: async () => {
      await Promise.all(
        registrations.map(({ adapter }) => adapter.drainObservedExits?.() ?? Promise.resolve())
      )
    }
  })
  const context: StructuredAgentAdapterContext = {
    deps,
    store,
    journalDatabase,
    environment: envResolvers,
    deliverLifecycle: lifecycle.deliver,
    followUps: createStructuredAgentSessionDispatchFollowUps({
      host: () => host,
      logger: deps.logger
    }),
    host: () => host
  }
  const registrations = STRUCTURED_AGENT_RUNTIME_REGISTRATIONS.map(
    ({ definition, createAdapter }) => ({ definition, adapter: createAdapter(context) })
  )
  const agents = new StructuredAgentRegistry(registrations)
  const adapter = new StructuredAgentSessionAdapterRouter(agents, async () => {
    await Promise.all(registrations.map((registration) => registration.adapter.closeAll()))
  })
  host = new StructuredAgentSessionHost({
    store,
    adapter,
    agents,
    recoveryCapsule: new AgentSessionRecoveryCapsule(deps.stateDirectory),
    journalDatabase,
    claimKeyId: deps.claimKeyId,
    probeOwner: createStructuredAgentSessionOwnerProbe(deps.hostId),
    probeOwners: createStructuredAgentSessionOwnerProbes(deps.hostId),
    resolveWorkspacePath: deps.resolveWorkspacePath,
    logger: deps.logger,
    ...(deps.onRequestFailure ? { onRequestFailure: deps.onRequestFailure } : {}),
    ...(deps.onSessionStatusChanged ? { onSessionStatusChanged: deps.onSessionStatusChanged } : {}),
    ...(deps.statusSink ? { statusSink: deps.statusSink } : {}),
    ...(deps.conversationNaming ? { conversationNaming: deps.conversationNaming } : {}),
    ...(deps.hasOpenDispatch ? { hasOpenDispatch: deps.hasOpenDispatch } : {}),
    ...(deps.startupLimits ? { startupLimits: deps.startupLimits } : {}),
    ...(deps.onSessionTabHidden ? { onSessionTabHidden: deps.onSessionTabHidden } : {}),
    ...(deps.assertNoTerminalWriter ? { assertNoTerminalWriter: deps.assertNoTerminalWriter } : {}),
    ...(await modelCatalogHostDeps({
      store,
      agents,
      registrations: STRUCTURED_AGENT_RUNTIME_REGISTRATIONS,
      deps,
      environment: envResolvers
    }))
  })
  if (deps.attentionDelivery) {
    const installed = host
    const delivery = deps.attentionDelivery
    installed.subscribeTurnCompletions({
      id: 'host-attention-delivery',
      includePrompts: true,
      emit: (event) => {
        if (event.type === 'end') {
          return
        }
        const sessionId =
          event.type === 'prompt' ? event.prompt.sessionId : event.completion.sessionId
        delivery.deliver(event, installed.readStatusSummary(sessionId))
      },
      onState: delivery.reconcile
    })
  }
  // Prewarm catalogs at runtime start for local and remote hosts.
  const modelCatalog = host.deps.modelCatalog
  void modelCatalog?.prewarm()
  installAgentSessionAttachments({
    stateDirectory: deps.stateDirectory,
    store,
    journalDatabase,
    logger: deps.logger
  })
  const stopVisualsSweep = deps.nativeChatVisuals
    ? scheduleNativeChatVisualsSweep({
        stateDirectory: deps.stateDirectory,
        listHeldSessionIds: () => (store.readOnly ? null : store.listHeldSessionIds()),
        logger: deps.logger
      })
    : undefined
  const stopCommands = bindAtRestCommandContexts(
    registrations.map(({ adapter }) => adapter.atRestCommands)
  )
  const unbindEnvironment = envResolvers.bindCatalogSources(
    registrations.map(({ definition }) => definition.agent)
  )
  try {
    setStructuredAgentSessionHost(host)
  } catch (error) {
    unbindEnvironment()
    stopCommands()
    throw error
  }
  return {
    host,
    adapter,
    journalDatabase,
    waitForRecovery: lifecycle.drain,
    stopBackgroundWork: () => {
      unbindEnvironment()
      stopCommands()
      stopVisualsSweep?.()
      modelCatalog?.stop()
    }
  }
}
