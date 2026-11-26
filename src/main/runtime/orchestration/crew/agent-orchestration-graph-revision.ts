import { isDeepStrictEqual } from 'node:util'
import type { RuntimeAgentOrchestrationProjection } from './runtime-agent-orchestration-projection'
import type { AgentStatusOrchestrationContext } from '../../../../shared/agent-status/contracts/agent-status-types'

type Contexts = Record<string, AgentStatusOrchestrationContext>

/** A window graph reply carries the projection only when it differs from the revision the window applied. */
export class AgentOrchestrationGraphRevision {
  private revision = 0
  private published: Contexts = {}

  constructor(
    private readonly projection: Pick<RuntimeAgentOrchestrationProjection, 'buildByPaneKey'>
  ) {}

  since(base: number | undefined): {
    agentOrchestrationRevision: number
    agentOrchestrationByPaneKey?: Contexts
  } {
    const next = this.projection.buildByPaneKey()
    const contexts = next ?? {}
    if (this.revision === 0 || !isDeepStrictEqual(contexts, this.published)) {
      this.revision++
      this.published = contexts
    }
    return base === this.revision || !next
      ? { agentOrchestrationRevision: this.revision }
      : { agentOrchestrationRevision: this.revision, agentOrchestrationByPaneKey: next }
  }
}
