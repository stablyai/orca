import type { AgentJournalSnapshot } from '../../../shared/agent-session-journal-types'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { randomUUID } from 'node:crypto'
import type { AgentSessionExecutionView } from '../../../shared/agent-session-execution-view'
import { projectStructuredAgentSessionStatusSummary } from '../../../shared/structured-agent-session-projection'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'
import { currentStructuredSessionLiveItems } from './structured-agent-session-live-items'
import { resolveStructuredAgentSessionExecution } from './structured-agent-session-execution-view'

/** Ordered metadata owned by the existing client-delivery boundary. */
export class StructuredAgentSessionExecutionPublication {
  private readonly incarnation = randomUUID()
  private revision = 0
  private readonly snapshots = new WeakMap<AgentSessionJournal, AgentJournalSnapshot>()
  private readonly published = new Map<string, { key: string; view: AgentSessionExecutionView }>()

  constructor(
    private readonly sessions: ReadonlyMap<string, StructuredAgentSessionHostSession>,
    private readonly deps: () => StructuredAgentSessionHostDeps,
    private readonly observation: (
      sessionId: string
    ) => 'live' | 'unverifiable' | 'exited' | undefined
  ) {}

  forget = (sessionId: string): void => {
    this.published.delete(sessionId)
  }

  read = (sessionId: string): AgentSessionExecutionView | undefined => {
    const session = this.sessions.get(sessionId)
    const record = this.deps().store.getRecord(sessionId)
    if (!session || !record) {
      return undefined
    }
    const cursor = session.journal.cursor()
    let snapshot = this.snapshots.get(session.journal)
    if (
      !snapshot ||
      snapshot.cursor.epoch !== cursor.epoch ||
      snapshot.cursor.sequence !== cursor.sequence
    ) {
      snapshot = session.journal.snapshot()
      this.snapshots.set(session.journal, snapshot)
    }
    const background = this.deps().adapter.backgroundTaskState?.(sessionId)
    const facts = resolveStructuredAgentSessionExecution({
      record,
      nativeBound: session.hasProviderChild && session.fence === record.lease.runtimeFence,
      observation: this.observation(sessionId),
      currentItems: currentStructuredSessionLiveItems(
        session.journal,
        session.fence,
        snapshot.items
      ),
      submissions: snapshot.submissions,
      backgroundWork: background?.tasks?.some((task) => task.state === 'working') === true
    })
    const semantic = {
      sessionId,
      location: record.location,
      fence: record.lease.runtimeFence,
      acquisitionGeneration: session.acquisitionGeneration,
      ...facts,
      historicalStatus: projectStructuredAgentSessionStatusSummary(
        snapshot.items,
        snapshot.submissions,
        session.fence
      ).status
    }
    const key = JSON.stringify({ ...semantic, epoch: snapshot.cursor.epoch })
    const previous = this.published.get(sessionId)
    if (previous?.key === key) {
      return previous.view
    }
    const view = {
      ...semantic,
      cursor: snapshot.cursor,
      hostIncarnation: this.incarnation,
      revision: ++this.revision
    }
    this.published.set(sessionId, { key, view })
    return view
  }
}
