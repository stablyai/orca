import { agentModelCatalogStore } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import { createAgentModelCatalogFilePersistence } from '../native-chat/agent-model-catalog/agent-model-catalog-persistence'
import {
  createAgentModelCatalogService,
  type AgentModelCatalogService,
  type AgentModelCatalogServiceDeps
} from '../native-chat/agent-model-catalog/agent-model-catalog-service'
import { createCodexModelCatalogProbe } from '../codex/codex-model-catalog-probe'
import { createClaudeModelCatalogProbe } from '../claude/claude-model-catalog-probe'
import { workspaceMayOverrideDefaultModel } from '../native-chat/agent-model-catalog/agent-project-model-override'
import type { ClaudeStructuredLaunchResolverDeps } from '../claude/claude-structured-launch-resolution'
import type { CodexStructuredLaunchResolverDeps } from '../codex/codex-structured-launch-resolution'
import type { AgentSessionRecordStore } from './agent-session-record-store'
import type { StructuredAgentSessionRuntimeDeps } from './structured-agent-session-runtime'

// The store is process-global; hydrate it from disk at most once per process.
let persistenceAttached = false

export async function attachAgentModelCatalogPersistenceOnce(
  stateDirectory: string
): Promise<void> {
  if (persistenceAttached) {
    return
  }
  persistenceAttached = true
  try {
    await agentModelCatalogStore.attachPersistence(
      createAgentModelCatalogFilePersistence(stateDirectory)
    )
  } catch {
    // A missing or unreadable file only costs the warm start.
  }
}

/**
 * The host-deps slice for the catalog surface: hydrates the store from disk
 * once, then builds the service — or nothing, when the runtime cannot name
 * the currently selected account, in which case every catalog read answers
 * `unknown` rather than guessing a key.
 *
 * The probes list through the SAME invocation resolvers session launches use;
 * a probe under a different env or binary could list models the user's
 * sessions cannot see, under their key.
 */
export async function modelCatalogHostDeps(input: {
  store: Pick<AgentSessionRecordStore, 'getRecord'>
  deps: Pick<
    StructuredAgentSessionRuntimeDeps,
    | 'stateDirectory'
    | 'resolveAgentAccountHome'
    | 'resolveCodexCommand'
    | 'resolveClaudeCommand'
    | 'resolveClaudeLaunchEnv'
    | 'resolveClaudeAuthPolicy'
  >
  envResolvers: {
    resolveCodexEnvironment: NonNullable<CodexStructuredLaunchResolverDeps['resolveEnvironment']>
    resolveClaudeInheritedEnv: NonNullable<
      ClaudeStructuredLaunchResolverDeps['resolveInheritedEnv']
    >
  }
}): Promise<{ modelCatalog?: AgentModelCatalogService }> {
  await attachAgentModelCatalogPersistenceOnce(input.deps.stateDirectory)
  const { deps } = input
  if (!deps.resolveAgentAccountHome) {
    return {}
  }
  const modelCatalog = createAgentModelCatalogService({
    store: agentModelCatalogStore,
    getRecord: (sessionId) => input.store.getRecord(sessionId) ?? undefined,
    resolveAccountHome: deps.resolveAgentAccountHome,
    workspaceMayOverrideDefaultModel,
    probes: {
      codex: createCodexModelCatalogProbe({
        resolveEnvironment: input.envResolvers.resolveCodexEnvironment,
        ...(deps.resolveCodexCommand ? { resolveCommand: deps.resolveCodexCommand } : {})
      }),
      claude: createClaudeModelCatalogProbe({
        resolveInheritedEnv: input.envResolvers.resolveClaudeInheritedEnv,
        resolveAuthPolicy: deps.resolveClaudeAuthPolicy,
        ...(deps.resolveClaudeCommand ? { resolveCommand: deps.resolveClaudeCommand } : {}),
        ...(deps.resolveClaudeLaunchEnv ? { resolveEnv: deps.resolveClaudeLaunchEnv } : {})
      })
    }
  })
  return { modelCatalog }
}

// Re-exported so the runtime deps type can reference the resolver shape without
// importing the service module directly.
export type RuntimeAgentAccountHomeResolver = AgentModelCatalogServiceDeps['resolveAccountHome']
