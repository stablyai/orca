// Loaded on first host install: the host, router and every provider adapter stay out of startup.

import { writeStructuredAgentSessionOrcaNote } from '../../../native-chat/agent-session-wire/structured-agent-session-orca-note'
import { readTurnEndedItems } from '../../../native-chat/agent-session-wire/structured-agent-session-turn-context'
import { bindAtRestCommandContexts } from '../../../native-chat/agent-session-wire/options/at-rest-command-context'
import { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-host'
import { StructuredAgentSessionAdapterRouter } from '../../../native-chat/agent-session-wire/providers/structured-agent-session-adapter-router'
import { StructuredAgentRegistry } from '../../../native-chat/agent-session-wire/providers/structured-agent-registry'
import {
  createStructuredAgentSessionProviderNaming,
  withProviderNaming
} from '../../../native-chat/agent-session-wire/providers/structured-agent-session-provider-naming'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { scheduleNativeChatVisualsSweep } from '../../../native-chat/conversation-files/native-chat-visuals-sweep'
import type { InstalledRuntime } from './structured-agent-session-runtime-teardown'
import { AgentSessionRecoveryCapsule } from '../records/agent-session-recovery-capsule'
import type { OpenedAgentSessionRecordStore } from '../records/agent-session-record-store-slot'
import { installAgentSessionAttachments } from './structured-agent-session-attachment-wiring'
import {
  createStructuredAgentSessionOwnerProbe,
  createStructuredAgentSessionOwnerProbes
} from '../ownership/structured-agent-session-owner-probe'
import type { StructuredAgentAdapterContext } from './structured-agent-runtime-registration-types'
import { STRUCTURED_AGENT_RUNTIME_REGISTRATIONS } from './structured-agent-runtime-registrations'
import { createStructuredAgentSessionLifecycleDelivery } from '../lifecycle/structured-agent-session-lifecycle-delivery'
import { createStructuredAgentSessionDispatchFollowUps } from '../lifecycle/structured-agent-session-dispatch-followups'
import type { CatalogOwner } from '../model-catalog/structured-agent-model-catalog-wiring'
import type { StructuredAgentSessionRuntimeDeps } from './structured-agent-session-runtime-contract'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import { observePRWatchCommittedRows } from '../lifecycle/pr-watch-runtime'

export async function installOnJournal(
  deps: StructuredAgentSessionRuntimeDeps,
  { journalDatabase, store }: OpenedAgentSessionRecordStore,
  catalogOwner: CatalogOwner
): Promise<InstalledRuntime> {
  const envResolvers = catalogOwner.environment
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
  const providerNaming = createStructuredAgentSessionProviderNaming({
    adapter,
    logger: deps.logger
  })
  const nameProvider = (record: AgentSessionRecord): void => void providerNaming.push(record)
  host = new StructuredAgentSessionHost({
    store,
    adapter,
    nameProviderConversation: (record) => void providerNaming.push(record, true),
    agents,
    recoveryCapsule: new AgentSessionRecoveryCapsule(deps.stateDirectory),
    journalDatabase,
    claimKeyId: deps.claimKeyId,
    usageLimitAutoContinue: deps.usageLimitAutoContinue,
    ...(deps.assertQueuedMessageAllowed
      ? { assertQueuedMessageAllowed: deps.assertQueuedMessageAllowed }
      : {}),
    ...(deps.idleSweep ? { idleSweep: deps.idleSweep } : {}),
    probeOwner: createStructuredAgentSessionOwnerProbe(deps.hostId),
    probeOwners: createStructuredAgentSessionOwnerProbes(deps.hostId),
    resolveWorkspacePath: deps.resolveWorkspacePath,
    logger: deps.logger,
    ...(deps.onRequestFailure ? { onRequestFailure: deps.onRequestFailure } : {}),
    ...(deps.onIdleProviderDeath ? { onIdleProviderDeath: deps.onIdleProviderDeath } : {}),
    observeCommittedRows: observePRWatchCommittedRows,
    ...(deps.onSessionStatusChanged ? { onSessionStatusChanged: deps.onSessionStatusChanged } : {}),
    ...(deps.readWorkerDockPresence ? { readWorkerDockPresence: deps.readWorkerDockPresence } : {}),
    ...(deps.statusSink ? { statusSink: deps.statusSink } : {}),
    ...(deps.conversationNaming
      ? { conversationNaming: withProviderNaming(deps.conversationNaming, nameProvider) }
      : {}),
    ...(deps.turnContext ? { turnContext: deps.turnContext } : {}),
    ...(deps.hasOpenDispatch ? { hasOpenDispatch: deps.hasOpenDispatch } : {}),
    ...(deps.quietTurnEnd ? { quietTurnEnd: deps.quietTurnEnd } : {}),
    ...(deps.isBotHome ? { isBotHome: deps.isBotHome } : {}),
    ...(deps.validateWorkTarget ? { validateWorkTarget: deps.validateWorkTarget } : {}),
    ...(deps.queuedAgentMessageOwed ? { queuedAgentMessageOwed: deps.queuedAgentMessageOwed } : {}),
    ...(deps.startupLimits ? { startupLimits: deps.startupLimits } : {}),
    ...(deps.onSessionTabHidden ? { onSessionTabHidden: deps.onSessionTabHidden } : {}),
    ...(deps.onMessageAdmitted ? { onMessageAdmitted: deps.onMessageAdmitted } : {}),
    ...(deps.launchAccountHome ? { launchAccountHome: deps.launchAccountHome } : {}),
    ...(deps.launchTools ? { launchTools: deps.launchTools } : {}),
    ...(deps.assertNoTerminalWriter ? { assertNoTerminalWriter: deps.assertNoTerminalWriter } : {}),
    ...(catalogOwner.modelCatalog ? { modelCatalog: catalogOwner.modelCatalog } : {})
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
  const turnEnded = deps.turnContext?.turnEnded
  if (turnEnded) {
    const installed = host
    installed.subscribeTurnCompletions({
      id: 'host-turn-context',
      emit: (event) => {
        if (event.type === 'completion') {
          const { sessionId, turnId, outcome } = event.completion
          turnEnded(
            sessionId,
            turnId,
            async (since) =>
              readTurnEndedItems(await installed.journalReads(sessionId), turnId, since),
            (clientMessageId, body) =>
              writeStructuredAgentSessionOrcaNote(installed, sessionId, clientMessageId, body),
            { outcome }
          )
        }
      }
    })
  }
  let turnAttention:
    | ReturnType<NonNullable<StructuredAgentSessionRuntimeDeps['createTurnAttention']>>
    | undefined
  let stopTurnAttention: (() => void) | undefined
  let stopVisualsSweep: (() => void) | undefined
  let stopCommands: (() => void) | undefined
  let detachCatalog: (() => void) | undefined
  try {
    turnAttention = deps.createTurnAttention?.()
    if (turnAttention) {
      const installed = host
      const onTurnAttention = turnAttention.onTurnAttention
      stopTurnAttention = installed.subscribeTurnCompletions({
        id: 'host-turn-attention',
        includePrompts: true,
        emit: (event) => onTurnAttention(event, installed.readStatusSummary)
      })
    }
    installAgentSessionAttachments({
      stateDirectory: deps.stateDirectory,
      store,
      journalDatabase,
      logger: deps.logger
    })
    stopVisualsSweep = deps.nativeChatVisuals
      ? scheduleNativeChatVisualsSweep({
          stateDirectory: deps.stateDirectory,
          listHeldSessionIds: () => (store.readOnly ? null : store.listHeldSessionIds()),
          logger: deps.logger
        })
      : undefined
    stopCommands = bindAtRestCommandContexts(
      registrations.map(({ adapter }) => adapter.atRestCommands)
    )
    detachCatalog = catalogOwner.attach({ store, host })
    void host.deps.modelCatalog?.prewarm()
    setStructuredAgentSessionHost(host)
    turnAttention?.start()
  } catch (error) {
    turnAttention?.stop()
    stopTurnAttention?.()
    detachCatalog?.()
    stopCommands?.()
    stopVisualsSweep?.()
    await providerNaming.stop()
    throw error
  }
  return {
    host,
    adapter,
    journalDatabase,
    waitForRecovery: lifecycle.drain,
    stopBackgroundWork: () => {
      turnAttention?.stop()
      stopTurnAttention?.()
      const namingStopped = providerNaming.stop()
      detachCatalog?.()
      stopCommands?.()
      stopVisualsSweep?.()
      return namingStopped
    }
  }
}
