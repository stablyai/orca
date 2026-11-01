import type { AgentModelCatalogRunningAccountDeps } from '../native-chat/agent-model-catalog/agent-model-catalog-running-account'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { agentSessionPinnedLaunchDirectory } from './agent-session-record-launch-directory'
import {
  agentModelCatalogStore,
  type AgentModelCatalogProbe
} from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import { createAgentModelCatalogFilePersistence } from '../native-chat/agent-model-catalog/agent-model-catalog-persistence'
import {
  createAgentModelCatalogService,
  type AgentModelCatalogService,
  type AgentModelCatalogServiceDeps
} from '../native-chat/agent-model-catalog/agent-model-catalog-service'
import {
  agentReadsProjectModelConfig,
  workspaceMayOverrideDefaultModel
} from '../native-chat/agent-model-catalog/agent-project-model-override'
import type { AgentSessionRecordStore } from './agent-session-record-store'
import type {
  StructuredAgentModelCatalogContext,
  StructuredAgentRuntimeRegistration
} from './structured-agent-runtime-registrations'
import type { StructuredAgentRegistry } from '../native-chat/agent-session-wire/structured-agent-registry'
import { agentDrivesSession } from '../native-chat/agent-session-wire/structured-agent-session-provider-support'
import { createStructuredAgentEnvironmentResolvers } from './structured-agent-shell-environment'
import {
  STRUCTURED_AGENT_RUNTIME_METADATA,
  structuredAgentRuntimeMetadata
} from './structured-agent-runtime-metadata'

// The store is process-global; hydrate it from disk at most once per process.
let persistenceAttached: Promise<void> | null = null

export async function attachAgentModelCatalogPersistenceOnce(
  stateDirectory: string
): Promise<void> {
  persistenceAttached ??= agentModelCatalogStore
    .attachPersistence(createAgentModelCatalogFilePersistence(stateDirectory))
    .catch(() => {})
  await persistenceAttached
}

type CatalogRegistration = Pick<StructuredAgentRuntimeRegistration, 'definition' | 'modelCatalog'>

/** What the catalog service learns from the registration list, the only agent roster. */
export function registeredModelCatalogDiscovery(
  registrations: readonly CatalogRegistration[],
  context: StructuredAgentModelCatalogContext
): {
  probes: Record<string, AgentModelCatalogProbe>
  listingNamesConfiguredModel: Set<string>
  listsInChatFolder: Set<string>
} {
  const probes: Record<string, AgentModelCatalogProbe> = {}
  const listingNamesConfiguredModel = new Set<string>()
  const listsInChatFolder = new Set<string>()
  for (const registration of registrations) {
    const { agent } = registration.definition
    const discovery = registration.modelCatalog(context)
    if (discovery.kind === 'probe') {
      probes[agent] = discovery.probe
      if (discovery.listingNamesConfiguredModel) {
        listingNamesConfiguredModel.add(agent)
      }
      if (discovery.listsInChatFolder) {
        listsInChatFolder.add(agent)
      }
    }
  }
  return { probes, listingNamesConfiguredModel, listsInChatFolder }
}

/** Build the existing catalog from late-bound session access; no journal is needed for discovery. */
export async function modelCatalogHostDeps(input: {
  store: Pick<AgentSessionRecordStore, 'getRecord' | 'getConversation' | 'listConversations'>
  agents: Pick<StructuredAgentRegistry, 'definition'>
  registrations: readonly CatalogRegistration[]
  host: () => StructuredAgentSessionHost | null
  deps: StructuredAgentModelCatalogContext['deps']
  environment: StructuredAgentModelCatalogContext['environment']
}): Promise<{ modelCatalog?: AgentModelCatalogService }> {
  await attachAgentModelCatalogPersistenceOnce(input.deps.stateDirectory)
  const { deps } = input
  if (!deps.resolveAgentAccountHome) {
    return {}
  }
  return {
    modelCatalog: createAgentModelCatalogService({
      store: agentModelCatalogStore,
      getConversation: (id) => input.store.getConversation(id) ?? undefined,
      getRecord: (id) => input.store.getRecord(id) ?? undefined,
      drivesRecord: (record) => agentDrivesSession(input.agents, record),
      resolveAccountHome: deps.resolveAgentAccountHome,
      ...structuredAgentModelCatalogAccountReads(input.host),
      recordWorkspacePath: async (record) =>
        agentSessionPinnedLaunchDirectory(record) ??
        (await deps.resolveWorkspacePath(record.location.workspaceId).catch(() => null)),
      agentReadsProjectModelConfig,
      workspaceMayOverrideDefaultModel,
      hasChatRecords: (agent) =>
        input.store.listConversations().some((record) => record.provider === agent),
      ...registeredModelCatalogDiscovery(input.registrations, {
        deps,
        environment: input.environment
      })
    })
  }
}

type SessionAccess = {
  store: Pick<AgentSessionRecordStore, 'getRecord' | 'getConversation' | 'listConversations'>
  host: StructuredAgentSessionHost
}

export type CatalogOwner = {
  environment: StructuredAgentModelCatalogContext['environment']
  modelCatalog?: AgentModelCatalogService
  attach: (access: SessionAccess) => () => void
  stop: () => Promise<void>
}
let ownerSlot: { pending: Promise<CatalogOwner>; retired: boolean } | null = null

/** Catalog demand and legitimate host installation share one generation, without opening a journal. */
export function ensureStructuredAgentModelCatalogOwner(
  deps: StructuredAgentModelCatalogContext['deps']
): Promise<CatalogOwner> {
  if (ownerSlot) {
    return ownerSlot.pending
  }
  const slot = { pending: constructCatalogOwner(deps), retired: false }
  ownerSlot = slot
  slot.pending = slot.pending
    .then(async (owner) => {
      if (slot.retired) {
        await owner.stop()
        throw new Error('catalog runtime stopped during construction')
      }
      return owner
    })
    .catch((error) => {
      if (ownerSlot === slot) {
        ownerSlot = null
      }
      throw error
    })
  return slot.pending
}

async function constructCatalogOwner(
  deps: StructuredAgentModelCatalogContext['deps']
): Promise<CatalogOwner> {
  await attachAgentModelCatalogPersistenceOnce(deps.stateDirectory)
  const environment = createStructuredAgentEnvironmentResolvers(deps)
  const unbind = environment.bindCatalogSources(
    STRUCTURED_AGENT_RUNTIME_METADATA.map(({ definition }) => definition.agent)
  )
  let access: SessionAccess | null = null
  let stopped = false
  try {
    const agents: Pick<StructuredAgentRegistry, 'definition'> = {
      definition: (agent) => structuredAgentRuntimeMetadata(agent)?.definition ?? null
    }
    const { modelCatalog } = await modelCatalogHostDeps({
      deps,
      environment,
      agents,
      registrations: STRUCTURED_AGENT_RUNTIME_METADATA,
      host: () => access?.host ?? null,
      store: {
        getConversation: (id) => access?.store.getConversation(id) ?? null,
        getRecord: (id) => access?.store.getRecord(id) ?? null,
        listConversations: () => access?.store.listConversations() ?? []
      }
    })
    return {
      environment,
      modelCatalog,
      attach(next) {
        if (stopped) {
          throw new Error('catalog runtime stopped before host attachment')
        }
        access = next
        return () => {
          if (access === next) {
            access = null
          }
        }
      },
      async stop() {
        stopped = true
        access = null
        unbind()
        await modelCatalog?.stop()
      }
    }
  } catch (error) {
    unbind()
    throw error
  }
}

/** Clear authority before waiting so late initialization cannot resurrect this generation. */
export async function stopStructuredAgentModelCatalogOwner(): Promise<void> {
  const slot = ownerSlot
  ownerSlot = null
  if (slot) {
    slot.retired = true
    const owner = await slot.pending.catch(() => null)
    await owner?.stop()
  }
}

/** Capture the constructing runtime's host lazily; global installation is a separate lifetime. */
export function structuredAgentModelCatalogAccountReads(
  readHost: () => Pick<StructuredAgentSessionHost, 'childAccountHome'> | null
): Pick<AgentModelCatalogRunningAccountDeps, 'liveAccountHome'> {
  return {
    liveAccountHome: (id) => readHost()?.childAccountHome(id)
  }
}

/** Relevant settings warm an existing owner; they never construct one or expand the used-agent policy. */
export function prewarmStructuredAgentModelCatalogs(): void {
  void ownerSlot?.pending.then((owner) => owner.modelCatalog?.prewarm()).catch(() => {})
}

// Re-exported so the runtime deps type can reference the resolver shape without
// importing the service module directly.
export type RuntimeAgentAccountHomeResolver = AgentModelCatalogServiceDeps['resolveAccountHome']
