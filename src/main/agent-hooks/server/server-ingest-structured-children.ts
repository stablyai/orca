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

/** Refusals that are the fence doing its job (late or superseded evidence), not a fault. */
const EXPECTED_REFUSALS: ReadonlySet<string> = new Set(['stale-invocation'])

export abstract class AgentHookServerIngestStructuredChildren extends AgentHookServerIngestStructured {
  /**
   * Admit one structured session's child-work evidence. The parent publication owns the subject
   * and lands first; this refuses to act on a subject the store does not already hold, so a
   * child can never conjure a parent row.
   */
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

  /** Every child record this host holds for one structured session. */
  getStructuredChildWork(subject: AgentStatusStructuredSessionSubject): AgentChildWorkRecord[] {
    const parent = parseAgentStatusSubject(subject)
    return parent ? this.canonicalStatusStore.getChildren(parent) : []
  }

  /** A record covers its current handles only while it answers to running work. */
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
