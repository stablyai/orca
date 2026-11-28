import type { AgentModelCatalogRunningAccountDeps } from '../../../native-chat/agent-model-catalog/agent-model-catalog-running-account'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-host'
import { agentSessionPinnedLaunchDirectory } from '../records/agent-session-record-launch-directory'
import { agentModelCatalogStore } from '../../../native-chat/agent-model-catalog/agent-model-catalog-store'
import type { AgentModelCatalogProbe } from '../../../native-chat/agent-model-catalog/agent-model-catalog-discovery'
import { createAgentModelCatalogFilePersistence } from '../../../native-chat/agent-model-catalog/agent-model-catalog-persistence'
import { createAgentModelCatalogService } from '../../../native-chat/agent-model-catalog/agent-model-catalog-service'
import type {
  AgentModelCatalogService,
  AgentModelCatalogServiceDeps
} from '../../../native-chat/agent-model-catalog/agent-model-catalog-service-contract'
import {
  agentReadsProjectModelConfig,
  workspaceMayOverrideDefaultModel
} from '../../../native-chat/agent-model-catalog/agent-project-model-override'
import type { AgentSessionRecordStore } from '../records/agent-session-record-store'
import type {
  StructuredAgentModelCatalogContext,
  StructuredAgentRuntimeRegistration
} from '../installation/structured-agent-runtime-registration-types'
import type { StructuredAgentRegistry } from '../../../native-chat/agent-session-wire/providers/structured-agent-registry'
import { agentDrivesSession } from '../../../native-chat/agent-session-wire/providers/structured-agent-session-provider-support'
import { createStructuredAgentEnvironmentResolvers } from '../environment/structured-agent-shell-environment'
import {
  listStructuredAgentRuntimeMetadata,
  STRUCTURED_AGENT_RUNTIME_METADATA,
  structuredAgentRuntimeMetadata
} from '../installation/structured-agent-runtime-metadata'
import { onCustomAcpAgentsChanged } from '../../../acp/custom/custom-acp-agent-registry'

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
  listsOnDemand: Set<string>
} {
  const probes: Record<string, AgentModelCatalogProbe> = {}
  const listingNamesConfiguredModel = new Set<string>()
  const listsInChatFolder = new Set<string>()
  const listsOnDemand = new Set<string>()
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
      if (discovery.listsOnDemand) {
        listsOnDemand.add(agent)
      }
    }
  }
  return {
    probes,
    listingNamesConfiguredModel,
    listsInChatFolder,
    listsOnDemand
  }
}

/** The registration list's discovery, plus the custom ACP agents settings define now and later:
 *  the service reads these collections on every lookup, so they are updated in place until
 *  `release` stops following the settings. */
function followedModelCatalogDiscovery(
  registrations: readonly CatalogRegistration[],
  context: StructuredAgentModelCatalogContext
): {
  discovery: ReturnType<typeof registeredModelCatalogDiscovery>
  release: () => void
} {
  const discovery = registeredModelCatalogDiscovery(registrations, context)
  // This discovery's custom ACP probes, by agent, kept while the agent stays defined.
  const customProbes = new Map<string, AgentModelCatalogProbe>()
  const builtIn = new Set(registrations.map(({ definition }) => definition.agent))
  const sync = (): void => {
    const late = listStructuredAgentRuntimeMetadata().filter(
      ({ definition }) => !builtIn.has(definition.agent)
    )
    const current = new Set(late.map(({ definition }) => definition.agent))
    for (const agent of customProbes.keys()) {
      if (!current.has(agent)) {
        customProbes.delete(agent)
        delete discovery.probes[agent]
        discovery.listsOnDemand.delete(agent)
      }
    }
    const added = late.filter(({ definition }) => !customProbes.has(definition.agent))
    const next = registeredModelCatalogDiscovery(added, context)
    for (const [agent, probe] of Object.entries(next.probes)) {
      customProbes.set(agent, probe)
      discovery.probes[agent] = probe
    }
    next.listsOnDemand.forEach((agent) => discovery.listsOnDemand.add(agent))
  }
  sync()
  return { discovery, release: onCustomAcpAgentsChanged(sync) }
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
  const followed = followedModelCatalogDiscovery(input.registrations, {
    deps,
    environment: input.environment
  })
  const modelCatalog = createAgentModelCatalogService({
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
    ...followed.discovery
  })
  const stop = modelCatalog.stop.bind(modelCatalog)
  // A stopped service stops following the settings, so a later one starts from its own probes.
  modelCatalog.stop = async () => {
    followed.release()
    await stop()
  }
  return { modelCatalog }
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
