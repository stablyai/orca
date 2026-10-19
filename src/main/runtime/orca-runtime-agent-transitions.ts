import { AgentTransitionDetector } from '../agent-hooks/agent-transition-detector'
import { OrcaRuntimeWithMigrationCatalog } from './orca-runtime-migration-catalog'
import type { AgentStatusStoreView } from './sidebar-inputs/workspace-activity-facts-producer'

/** Owns the runtime's agent transition detector, which runs on every host and in every build. */
export abstract class OrcaRuntimeWithAgentTransitions extends OrcaRuntimeWithMigrationCatalog {
  readonly agentTransitions = new AgentTransitionDetector({
    resolveTabWorktreeId: (tabId) => this.tabs.get(tabId)?.worktreeId,
    now: Date.now
  })

  /** Attaches the detector; layers above subscribe their readers first. */
  attachAgentStatusStore(store: AgentStatusStoreView): () => void {
    return this.agentTransitions.attach(store)
  }
}
