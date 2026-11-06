// Loaded on first host install: the host, router and every provider adapter stay out of startup.

import { bindAtRestCommandContexts } from '../../../native-chat/agent-session-wire/at-rest-command-context'
import { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import { StructuredAgentSessionAdapterRouter } from '../../../native-chat/agent-session-wire/structured-agent-session-adapter-router'
import { StructuredAgentRegistry } from '../../../native-chat/agent-session-wire/structured-agent-registry'
import {
  createStructuredAgentSessionProviderNaming,
  withProviderNaming
} from '../../../native-chat/agent-session-wire/structured-agent-session-provider-naming'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { scheduleNativeChatVisualsSweep } from '../../../native-chat/native-chat-visuals-sweep'
import type { InstalledRuntime } from '../structured-agent-session-runtime-teardown'
import { AgentSessionRecoveryCapsule } from '../records/agent-session-recovery-capsule'
import type { OpenedAgentSessionRecordStore } from '../records/agent-session-record-store-slot'
import { installAgentSessionAttachments } from '../structured-agent-session-attachment-wiring'
import {
  createStructuredAgentSessionOwnerProbe,
  createStructuredAgentSessionOwnerProbes
} from '../structured-agent-session-owner-probe'
import type { StructuredAgentAdapterContext } from './structured-agent-runtime-registration-types'
import { STRUCTURED_AGENT_RUNTIME_REGISTRATIONS } from './structured-agent-runtime-registrations'
import { createStructuredAgentSessionLifecycleDelivery } from '../structured-agent-session-lifecycle-delivery'
import { createStructuredAgentSessionDispatchFollowUps } from '../structured-agent-session-dispatch-followups'
import type { CatalogOwner } from '../model-catalog/structured-agent-model-catalog-wiring'
import type { StructuredAgentSessionRuntimeDeps } from './structured-agent-session-runtime-contract'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import { PRWatchService } from '../../../github/pr-watch/pr-watch-service'
import { attachPRWatchSource } from '../../../github/pr-watch/pr-watch-seams'
import type { JournalHostDatabase } from '../../../native-chat/agent-session-journal/journal-host-database'
import type { AgentSessionJournal } from '../../../native-chat/agent-session-journal/journal-store'
import type { AgentSessionRecordStore } from '../records/agent-session-record-store'

/** CI lines for chats in git worktrees; folder workspaces have no checkout to read a PR through. */
function createPRWatchService(
  sources: NonNullable<StructuredAgentSessionRuntimeDeps['pullRequestWatch']>,
  store: AgentSessionRecordStore,
  database: JournalHostDatabase,
  host: () => StructuredAgentSessionHost | null,
  logger: StructuredAgentSessionRuntimeDeps['logger']
): PRWatchService {
  return new PRWatchService({
    database,
    chatExists: (chatId) => store.getConversation(chatId) != null,
    chatWorkspace: async (chatId) => {
      const location = store.getConversation(chatId)?.location
      return location?.workspaceKind === 'git-worktree'
        ? sources.resolveWorkspace(location.workspaceId).catch(() => null)
        : null
    },
    resolveRepo: sources.resolveRepo,
    chatFence: (chatId) => store.getConversation(chatId)?.currentFence ?? null,
    openJournal: (chatId) => {
      // The publication feed hands a new observer the chat's open journal, if any, at once.
      let journal: AgentSessionJournal | null = null
      host()?.observeConversationPublications(chatId, {
        next: (hint) => (journal ??= hint.journal),
        error: () => {}
      })?.()
      return journal
    },
    logger
  })
}

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
  const prWatch = deps.pullRequestWatch
    ? createPRWatchService(deps.pullRequestWatch, store, journalDatabase, () => host, deps.logger)
    : null
  host = new StructuredAgentSessionHost({
    store,
    adapter,
    nameProviderConversation: (record) => void providerNaming.push(record, true),
    agents,
    recoveryCapsule: new AgentSessionRecoveryCapsule(deps.stateDirectory),
    journalDatabase,
    claimKeyId: deps.claimKeyId,
    usageLimitAutoContinue: deps.usageLimitAutoContinue,
    ...(deps.idleSweep ? { idleSweep: deps.idleSweep } : {}),
    probeOwner: createStructuredAgentSessionOwnerProbe(deps.hostId),
    probeOwners: createStructuredAgentSessionOwnerProbes(deps.hostId),
    resolveWorkspacePath: deps.resolveWorkspacePath,
    logger: deps.logger,
    ...(deps.onRequestFailure ? { onRequestFailure: deps.onRequestFailure } : {}),
    ...(prWatch
      ? {
          observeCommittedRows: (...args: Parameters<typeof prWatch.observeCommittedRows>): void =>
            prWatch.observeCommittedRows(...args)
        }
      : {}),
    ...(deps.onSessionStatusChanged ? { onSessionStatusChanged: deps.onSessionStatusChanged } : {}),
    ...(deps.statusSink ? { statusSink: deps.statusSink } : {}),
    ...(deps.conversationNaming
      ? { conversationNaming: withProviderNaming(deps.conversationNaming, nameProvider) }
      : {}),
    ...(deps.hasOpenDispatch ? { hasOpenDispatch: deps.hasOpenDispatch } : {}),
    ...(deps.queuedAgentMessageOwed ? { queuedAgentMessageOwed: deps.queuedAgentMessageOwed } : {}),
    ...(deps.startupLimits ? { startupLimits: deps.startupLimits } : {}),
    ...(deps.onSessionTabHidden ? { onSessionTabHidden: deps.onSessionTabHidden } : {}),
    ...(deps.launchAccountHome ? { launchAccountHome: deps.launchAccountHome } : {}),
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
  if (deps.onTurnAttention) {
    const installed = host
    const onTurnAttention = deps.onTurnAttention
    installed.subscribeTurnCompletions({
      id: 'host-turn-attention',
      includePrompts: true,
      emit: (event) => onTurnAttention(event, installed.readStatusSummary)
    })
  }
  // Prewarm catalogs at runtime start for local and remote hosts.
  const modelCatalog = host.deps.modelCatalog
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
  let detachCatalog: (() => void) | undefined
  let detachPRWatch: (() => void) | undefined
  try {
    detachCatalog = catalogOwner.attach({ store, host })
    void modelCatalog?.prewarm()
    setStructuredAgentSessionHost(host)
    if (prWatch && deps.pullRequestWatch) {
      detachPRWatch = attachPRWatchSource({
        resolveRepo: deps.pullRequestWatch.resolveRepo,
        pullRequestActionsFor: (prKey) => prWatch.pullRequestActionsFor(prKey),
        ownerChatFor: (prKey) => prWatch.ownerChatFor(prKey)
      })
      void prWatch
        .start()
        .catch((error: unknown) =>
          deps.logger.warn('starting CI-line watches failed', { scope: 'pr-watch', error })
        )
    }
  } catch (error) {
    detachPRWatch?.()
    prWatch?.stop()
    detachCatalog?.()
    stopCommands()
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
      detachPRWatch?.()
      prWatch?.stop()
      const namingStopped = providerNaming.stop()
      detachCatalog?.()
      stopCommands()
      stopVisualsSweep?.()
      return namingStopped
    }
  }
}
