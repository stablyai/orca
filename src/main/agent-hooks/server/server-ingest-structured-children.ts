import { randomUUID } from 'node:crypto'

import { createAgentChildWorkAdmission } from '../../../shared/agent-status-child-work-admission'
import {
  agentChildWorkFencesEqual,
  type AgentChildWorkRecord
} from '../../../shared/agent-status-child-work'
import { isLiveChildWork } from '../../../shared/agent-status-child-work-liveness'
import type { AgentChildWorkEvidence } from '../../../shared/agent-status-child-work-evidence'
import {
  reconcileAgentChildWorkEvidence,
  type AgentChildWorkReconcileOutcome
} from '../../../shared/agent-status-child-work-reconciliation'
import {
  projectAgentChildWorkViews,
  type AgentChildWorkView
} from '../../../shared/agent-status-child-work-view'
import {
  parseAgentStatusSubject,
  type AgentStatusStructuredSessionSubject
} from '../../../shared/agent-status-subject'
import { AgentHookServerIngestStructured } from './server-ingest-structured'

// Superseded evidence is an expected refusal.
const EXPECTED_REFUSALS: ReadonlySet<string> = new Set(['stale-invocation'])

export abstract class AgentHookServerIngestStructuredChildren extends AgentHookServerIngestStructured {
  /** Child evidence requires an already-published parent and cannot create one. */
  ingestStructuredChildWork(
    subject: AgentStatusStructuredSessionSubject,
    evidence: AgentChildWorkEvidence[],
    provider: string
  ): AgentChildWorkReconcileOutcome | null {
    const parent = parseAgentStatusSubject(subject)
    if (!parent || parent.kind !== 'structured-session') {
      throw new Error('Structured child work requires its exact owner subject')
    }
    const store = this.canonicalStatusStore
    if (!store.getParent(parent)) {
      return null
    }
    const outcome = reconcileAgentChildWorkEvidence({
      store,
      admission: createAgentChildWorkAdmission(store, { mintChildWorkId: () => randomUUID() }),
      parent,
      provider,
      evidence
    })
    const unexpected = outcome.rejected.filter(({ reason }) => !EXPECTED_REFUSALS.has(reason))
    if (unexpected.length > 0) {
      console.warn(
        '[agent-status-child-work] refused structured child evidence',
        unexpected.map(({ handleId, reason }) => `${handleId}:${reason}`)
      )
    }
    return outcome
  }

  getStructuredChildWork(subject: AgentStatusStructuredSessionSubject): AgentChildWorkRecord[] {
    const parent = parseAgentStatusSubject(subject)
    return parent ? this.canonicalStatusStore.getChildren(parent) : []
  }

  /** Only running work retains its handles. */
  getStructuredChildWorkHandles(subject: AgentStatusStructuredSessionSubject): Set<string> {
    return new Set(
      this.getStructuredChildWork(subject).flatMap((child) =>
        child.membership === 'live' && isLiveChildWork(child)
          ? this.canonicalStatusStore
              .getAliasesForChild(child.childWorkId)
              .filter(({ fence }) => agentChildWorkFencesEqual(fence, child.invocation))
              .map(({ alias }) => alias)
          : []
      )
    )
  }

  getStructuredChildWorkViews(subject: AgentStatusStructuredSessionSubject): AgentChildWorkView[] {
    const children = this.getStructuredChildWork(subject)
    return projectAgentChildWorkViews(
      children,
      children.flatMap((child) => this.canonicalStatusStore.getAliasesForChild(child.childWorkId))
    )
  }
}
