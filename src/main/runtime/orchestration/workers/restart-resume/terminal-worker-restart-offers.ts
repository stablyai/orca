// With "Resume work on restart" off, a terminal worker a reboot or daemon crash took waits on a person
// beside the cut chats: listed, resumed and dismissed through the same restart offer, keyed by Dispatch.

import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host/execution-host'
import { parseWorkspaceKey } from '../../../../../shared/workspace/identity/workspace-scope'
import type { StructuredAgentSessionResumeCandidate } from '../../../../native-chat/agent-session-wire/recovery/structured-agent-session-restart-resume-set'
import type { StructuredAgentSessionContinuationOutcome } from '../../../../native-chat/agent-session-wire/recovery/structured-agent-session-restart-continuation'
import type { OrchestrationDb } from '../../db/orchestration-db'
import {
  isWorkerRestartOffered,
  listWorkerRestartOffers
} from '../../db/worker-dispatch/worker-restart-resume'
import type { TerminalWorkerRestartResume } from './terminal-worker-restart-resume'

export type TerminalWorkerRestartOffersDeps = {
  getDb: () => OrchestrationDb | null
  resume: Pick<TerminalWorkerRestartResume, 'resumeOffered'>
  /** Today's outcome for a lost worker: its Dispatch fails and its coordinator hears it was lost. */
  failLost: (dispatchId: string) => void
}

export class TerminalWorkerRestartOffers {
  constructor(private readonly deps: TerminalWorkerRestartOffersDeps) {}

  /** Offered workers as restart offer rows, so the chats' own toast and status bar show them. */
  list(): StructuredAgentSessionResumeCandidate[] {
    const db = this.deps.getDb()
    return (db ? listWorkerRestartOffers(db) : []).map((offer) => ({
      sessionId: offer.dispatchId,
      workspaceId: offer.worktreeId,
      agent: offer.session.agent,
      work: { kind: 'turn', id: offer.dispatchId },
      trigger: 'crash',
      recordedAt: offer.offeredAt,
      latestPrompt: offer.taskName,
      executionHostId: LOCAL_EXECUTION_HOST_ID,
      workspaceKind:
        parseWorkspaceKey(offer.worktreeId)?.type === 'folder' ? 'folder' : 'git-worktree'
    }))
  }

  /** The ids among these that name an offered worker rather than a chat. */
  owned(ids: readonly string[] | undefined): string[] {
    const db = this.deps.getDb()
    if (!db) {
      return []
    }
    return ids === undefined
      ? listWorkerRestartOffers(db).map((offer) => offer.dispatchId)
      : ids.filter((id) => isWorkerRestartOffered(db, id))
  }

  /** A person's Resume: each worker resumes once in its own conversation, as with the setting on. */
  async continue(
    dispatchIds: readonly string[]
  ): Promise<StructuredAgentSessionContinuationOutcome[]> {
    return Promise.all(
      dispatchIds.map(async (dispatchId) => {
        const resumed = await this.deps.resume
          .resumeOffered(dispatchId, () => this.deps.failLost(dispatchId))
          .catch(() => false)
        return { sessionId: dispatchId, outcome: resumed ? 'continued' : 'refused' } as const
      })
    )
  }

  /** A person's dismissal ends each worker as a dismissed chat worker ends: its coordinator hears it now. */
  dismiss(dispatchIds: readonly string[]): number {
    const db = this.deps.getDb()
    let dismissed = 0
    for (const dispatchId of dispatchIds) {
      if (db && isWorkerRestartOffered(db, dispatchId)) {
        this.deps.failLost(dispatchId)
        dismissed += 1
      }
    }
    return dismissed
  }
}
