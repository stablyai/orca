import { randomUUID } from 'node:crypto'

import { createAgentChildWorkAdmission } from '../../../shared/agent-status-child-work-admission'
import {
  reconcileStructuredChildWork,
  type StructuredChildWorkReconcileOutcome
} from '../../../shared/agent-status-child-work-reconciliation'
import {
  STRUCTURED_SUPPORTS_STOP_ALL_FACT,
  STRUCTURED_SUPPORTS_TASK_STOP_FACT
} from '../../../shared/agent-status-child-work-structured-egress'
import type { StructuredChildWorkEvidence } from '../../../shared/agent-status-child-work-structured-evidence'
import {
  parseAgentStatusSubject,
  type AgentStatusStructuredSessionSubject
} from '../../../shared/agent-status-subject'
import { AgentHookServerIngestStructured } from './server-ingest-structured'

export abstract class AgentHookServerIngestStructuredChildren extends AgentHookServerIngestStructured {
  /**
   * Admit one structured session's full child-work roster. The parent publication owns
   * the subject and lands first; this refuses to act on a subject the store does not
   * already hold, so a child can never conjure a parent row.
   */
  ingestStructuredChildWork(
    subject: AgentStatusStructuredSessionSubject,
    evidence: StructuredChildWorkEvidence,
    provider: string
  ): StructuredChildWorkReconcileOutcome | null {
    const parent = parseAgentStatusSubject(subject)
    if (!parent || parent.kind !== 'structured-session') {
      throw new Error('Structured child work requires its exact owner subject')
    }
    const store = this.canonicalStatusStore
    if (!store.getParent(parent)) {
      return null
    }
    // Provider stop capability is a fact about the session, not about any one child.
    store.applyMutation({
      facts: [
        {
          subject: parent,
          key: STRUCTURED_SUPPORTS_TASK_STOP_FACT,
          value: evidence.supportsTaskStop
        },
        { subject: parent, key: STRUCTURED_SUPPORTS_STOP_ALL_FACT, value: evidence.supportsStopAll }
      ]
    })
    const outcome = reconcileStructuredChildWork({
      store,
      admission: createAgentChildWorkAdmission(store, { mintChildWorkId: () => randomUUID() }),
      parent,
      provider,
      evidence,
      observedAt: Date.now()
    })
    if (outcome.rejected.length > 0) {
      console.warn(
        '[agent-status-child-work] refused structured child admissions',
        outcome.rejected.map(
          (entry) => `${entry.providerTaskId || entry.childWorkId}:${entry.reason}`
        )
      )
    }
    return outcome
  }

  /** Every canonical child this host holds for one structured session. */
  getStructuredChildWork(subject: AgentStatusStructuredSessionSubject) {
    const parent = parseAgentStatusSubject(subject)
    return parent ? this.canonicalStatusStore.getChildren(parent) : []
  }
}
