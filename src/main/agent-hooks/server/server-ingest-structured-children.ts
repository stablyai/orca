import { randomUUID } from 'node:crypto'

import { createAgentChildWorkAdmission } from '../../../shared/agent-status-child-work-admission'
import type { AgentChildWorkRecord } from '../../../shared/agent-status-child-work'
import type { AgentChildWorkEvidence } from '../../../shared/agent-status-child-work-evidence'
import {
  reconcileAgentChildWorkEvidence,
  type AgentChildWorkReconcileOutcome
} from '../../../shared/agent-status-child-work-reconciliation'
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
}
