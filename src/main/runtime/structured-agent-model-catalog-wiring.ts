import { agentSessionPinnedLaunchDirectory } from './agent-session-record-launch-directory'
import { agentModelCatalogStore } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
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
import type { AgentModelCatalogProbe } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import type { AgentSessionRecordStore } from './agent-session-record-store'
import type {
  StructuredAgentModelCatalogContext,
  StructuredAgentRuntimeRegistration
} from './structured-agent-runtime-registrations'
import type { StructuredAgentRegistry } from '../native-chat/agent-session-wire/structured-agent-registry'
import { agentDrivesSession } from '../native-chat/agent-session-wire/structured-agent-session-provider-support'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'

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

/** Hydrate once and build catalog service only with a known selected account; otherwise answer unknown rather than guess its key. */
export async function modelCatalogHostDeps(input: {
  store: Pick<AgentSessionRecordStore, 'getRecord' | 'listRecords'>
  agents: Pick<StructuredAgentRegistry, 'definition'>
  registrations: readonly CatalogRegistration[]
  deps: StructuredAgentModelCatalogContext['deps']
  environment: StructuredAgentModelCatalogContext['environment']
}): Promise<{ modelCatalog?: AgentModelCatalogService }> {
  await attachAgentModelCatalogPersistenceOnce(input.deps.stateDirectory)
  const { deps } = input
  if (!deps.resolveAgentAccountHome) {
    return {}
  }
  const modelCatalog = createAgentModelCatalogService({
    store: agentModelCatalogStore,
    getRecord: (sessionId) => input.store.getRecord(sessionId) ?? undefined,
    drivesRecord: (record) => agentDrivesSession(input.agents, record),
    resolveAccountHome: deps.resolveAgentAccountHome,
    recordWorkspacePath: async (record) =>
      agentSessionPinnedLaunchDirectory(record) ??
      (await deps.resolveWorkspacePath(record.location.workspaceId).catch(() => null)),
    agentReadsProjectModelConfig,
    workspaceMayOverrideDefaultModel,
    hasChatRecords: (agent) =>
      input.store.listRecords().some((record) => record.provider === agent),
    ...registeredModelCatalogDiscovery(input.registrations, {
      deps,
      environment: input.environment
    })
  })
  return { modelCatalog }
}

/** The installed host lists what a changed account or agent setting made cold; with no host yet,
 *  its install lists everything anyway. */
export function prewarmStructuredAgentModelCatalogs(): void {
  void getStructuredAgentSessionHost()?.deps.modelCatalog?.prewarm()
}

// Re-exported so the runtime deps type can reference the resolver shape without
// importing the service module directly.
export type RuntimeAgentAccountHomeResolver = AgentModelCatalogServiceDeps['resolveAccountHome']
