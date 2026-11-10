import type {
  AgentUpdateRequest,
  AgentUpdatesState
} from '../../shared/agent-updates/agent-update-types'

export type AgentUpdatesApi = {
  getState(): Promise<AgentUpdatesState>
  /** Reuses a recent check; re-checks installed agents once it is older than the cache window. */
  refresh(): Promise<AgentUpdatesState>
  /** Resolves when the requested agents finish updating; progress arrives through `onState`. */
  update(request: AgentUpdateRequest): Promise<void>
  onState(callback: (state: AgentUpdatesState) => void): () => void
}
