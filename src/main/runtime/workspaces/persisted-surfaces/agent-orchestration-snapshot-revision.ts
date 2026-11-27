import { isDeepStrictEqual } from 'node:util'
import type { AgentStatusOrchestrationContext } from '../../../../shared/agent-status/contracts/agent-status-types'
import {
  AGENT_ACTIVITY_ORCHESTRATION_MAX_CONTEXTS,
  type AgentActivityOrchestrationResult
} from '../../../../shared/rpc-contract/agent-activity/agent-activity-params'

type Contexts = Record<string, AgentStatusOrchestrationContext>

const DEFAULT_CACHE_TTL_MS = 1_000

/**
 * Shared, revisioned worker-lineage snapshot for paired desktop RPCs.
 * Coalesces concurrent/burst reads from multiple subscribers into one projection build and
 * answers unchanged revisions without re-sending contexts.
 */
export class AgentOrchestrationSnapshotRevision {
  private revision = 0
  private published: Contexts = {}
  private dirty = true
  private builtAt = -Infinity
  private readonly maxContexts: number
  private readonly cacheTtlMs: number
  private readonly now: () => number

  constructor(
    private readonly buildByPaneKey: () => Contexts | undefined,
    options: { maxContexts?: number; cacheTtlMs?: number; now?: () => number } = {}
  ) {
    this.maxContexts = options.maxContexts ?? AGENT_ACTIVITY_ORCHESTRATION_MAX_CONTEXTS
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
    this.now = options.now ?? Date.now
  }

  invalidate(): void {
    this.dirty = true
  }

  since(sinceRevision?: number): AgentActivityOrchestrationResult {
    const currentTime = this.now()
    if (this.dirty || this.revision === 0 || currentTime - this.builtAt >= this.cacheTtlMs) {
      const next = this.buildByPaneKey()
      const capped = next ? Object.fromEntries(Object.entries(next).slice(0, this.maxContexts)) : {}
      if (this.revision === 0 || !isDeepStrictEqual(capped, this.published)) {
        this.revision += 1
        this.published = capped
      }
      this.dirty = false
      this.builtAt = currentTime
    }
    if (sinceRevision !== undefined && sinceRevision === this.revision) {
      return { revision: this.revision, unchanged: true }
    }
    return { revision: this.revision, contexts: this.published }
  }
}
