// Each subagent's own saved row, written from the host's record of it.
//
// The host's child-work records are the one account of a subagent, for every agent: what started
// it, which run is current and how that run ended. Its journal row is their durable copy, written
// here each time a record changes, where the subagent was spawned. The saved row is also the
// dedupe: a record that reads as its row already does writes nothing, and a write that fails is
// tried again by the next change after its batch settles, so nothing here holds an obligation of
// its own. What a lost write leaves saying `working` the journal's reopen pass settles as
// unverifiable.
//
// A row a child's report changes is written through that child's own sink, so it lands after the
// settlement its attach writes first, and names that child as the run executing the subagent
// (`JournalItemRow.executionOwner`): a subagent a later run resumes is that run's work.

import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalTurnScope
} from '../../../shared/agent-session-journal-types'
import type { AgentChildWorkInput } from '../../../shared/agent-status-child-work'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import type {
  NativeChatSubagentBlock,
  NativeChatSubagentState
} from '../../../shared/native-chat-types'
import { structuredRunningChildWork } from '../../../shared/agent-child-work-listing'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  journaledSubagent,
  subagentJournalBody,
  subagentJournalItemIdentity
} from '../agent-session-journal/journal-subagent-item'
import type { StructuredAgentSessionCurrentWork } from './structured-agent-session-current-work'
import type {
  StructuredAgentSessionEventSink,
  StructuredAgentSessionSinkAdmission,
  StructuredAgentSessionSinkBarrier
} from './structured-agent-session-event-sink'

const UNNAMED = 'subagent'
const LANDED: StructuredAgentSessionSinkBarrier = { ok: true }
const LANDED_ADMISSION: StructuredAgentSessionSinkAdmission = { accepted: true }
const THREAD_GROUP = 'thread'

/** A child's view, with the host-only facts its saved row also keeps. */
export type AgentChildWorkRowView = AgentChildWorkView &
  Pick<AgentChildWorkInput, 'outcomeBasis' | 'residency'>

/** The child-bound write path of the child whose report changed the records. */
export type StructuredAgentSessionChildWorkProducer = Pick<
  StructuredAgentSessionEventSink,
  'appendItem' | 'tryAppendItem' | 'written'
>

type Row = {
  block: NativeChatSubagentBlock
  turnScope: AgentJournalTurnScope
  producer: StructuredAgentSessionChildWorkProducer | undefined
}

export type StructuredAgentSessionSubagentRowsDeps = {
  journal: (sessionId: string) => AgentSessionJournal | undefined
  fence: (sessionId: string) => number
  /** The host's read of what runs, whose turn a first row joins. */
  currentWork: (
    sessionId: string,
    journal: AgentSessionJournal
  ) => Pick<StructuredAgentSessionCurrentWork, 'turnScope'>
  readChildWork: (sessionId: string) => AgentChildWorkRowView[] | undefined
  onWriteFailed: (sessionId: string, error: unknown) => void
}

export class StructuredAgentSessionSubagentRows {
  /** Rows waiting for the session's writer, newest per subagent. */
  private readonly queued = new Map<string, Map<string, Row>>()
  /** The batch each session's writer has in flight: written, but not yet readable by key. */
  private readonly writing = new Map<string, Map<string, Row>>()
  /** The running subagents each child has written once: the rows it executes. */
  private readonly claimed = new WeakMap<StructuredAgentSessionChildWorkProducer, Set<string>>()

  constructor(private readonly deps: StructuredAgentSessionSubagentRowsDeps) {}

  /** The session's child records changed, by `producer`'s report when a child made one: queue each
   *  subagent whose row says otherwise, and each running one that child has not written yet. */
  changed(sessionId: string, producer?: StructuredAgentSessionChildWorkProducer): void {
    const journal = this.deps.journal(sessionId)
    const children = this.deps.readChildWork(sessionId)
    if (!journal || !children?.some((child) => child.kind === 'agent')) {
      return
    }
    const queued = this.queued.get(sessionId) ?? new Map<string, Row>()
    const claimed = producer && (this.claimed.get(producer) ?? new Set<string>())
    const providerIds = new Map(children.map((child) => [child.id, child.providerId]))
    // The strip's rule: a child that finished while work it started runs is still running.
    const running = new Set(structuredRunningChildWork(children).map((child) => child.id))
    // A full journal pass, so read once, and only for a first row: a revision keeps the scope
    // its first write froze.
    let live: AgentJournalTurnScope | undefined
    for (const child of children) {
      const id = child.providerId
      if (child.kind !== 'agent' || id === undefined) {
        continue
      }
      const pending = queued.get(id) ?? this.writing.get(sessionId)?.get(id)
      const saved = pending?.block ?? journaledSubagent(journal, id)
      const turnScope =
        pending?.turnScope ??
        (saved
          ? AGENT_JOURNAL_THREAD_SCOPE
          : (live ??= this.deps.currentWork(sessionId, journal).turnScope()))
      const parentId =
        child.parentChildWorkId === undefined ? undefined : providerIds.get(child.parentChildWorkId)
      const block = subagentRowBlock(child, id, parentId, saved, turnScope, running.has(child.id))
      // A running subagent another child now reports is that child's, even when its row reads the same.
      const moved = running.has(child.id) && claimed !== undefined && !claimed.has(id)
      if (!saved || moved || rowText(saved) !== rowText(block)) {
        queued.set(id, { block, turnScope, producer: producer ?? pending?.producer })
        claimed?.add(id)
      }
    }
    if (producer && claimed) {
      this.claimed.set(producer, claimed)
    }
    if (queued.size > 0) {
      this.queued.set(sessionId, queued)
      void this.write(sessionId)
    }
  }

  private async write(sessionId: string): Promise<void> {
    if (this.writing.has(sessionId)) {
      return
    }
    try {
      for (let rows = this.take(sessionId); rows; rows = this.take(sessionId)) {
        const journal = this.deps.journal(sessionId)
        // A closed conversation's unwritten rows are the reopen pass's to settle.
        if (!journal) {
          return
        }
        this.writing.set(sessionId, rows)
        // The journal serializes its writes; these land in the order they were queued.
        await Promise.all(
          [...rows].map(([id, row]) => {
            const identity = subagentJournalItemIdentity(id)
            const body = subagentJournalBody(row.block)
            if (row.producer) {
              return this.writeThrough(sessionId, id, row, row.producer)
            }
            return journal
              .appendItem(identity, body, {
                fence: this.deps.fence(sessionId),
                turnScope: row.turnScope
              })
              .catch((error: unknown) => this.deps.onWriteFailed(sessionId, error))
          })
        )
      }
    } finally {
      this.writing.delete(sessionId)
    }
  }

  /** Through the reporting child's sink, in its order and at its fence. A write it refuses under
   *  backpressure is queued again once what it holds has landed; any failure frees the claim. */
  private async writeThrough(
    sessionId: string,
    id: string,
    row: Row,
    producer: StructuredAgentSessionChildWorkProducer
  ): Promise<void> {
    const identity = subagentJournalItemIdentity(id)
    const body = subagentJournalBody(row.block)
    const options = { turnScope: row.turnScope, executes: true as const }
    const admission = producer.tryAppendItem
      ? producer.tryAppendItem(identity, body, options)
      : (producer.appendItem(identity, body, options), LANDED_ADMISSION)
    const landed = await (producer.written?.() ?? Promise.resolve(LANDED))
    if (admission.accepted && landed.ok) {
      return
    }
    this.claimed.get(producer)?.delete(id)
    if (!landed.ok) {
      this.deps.onWriteFailed(sessionId, landed.error)
    } else if (!admission.accepted && admission.reason === 'backpressure') {
      const queued = this.queued.get(sessionId) ?? new Map<string, Row>()
      // A newer report of the same subagent supersedes this one.
      if (!queued.has(id)) {
        queued.set(id, row)
      }
      this.queued.set(sessionId, queued)
    } else if (!admission.accepted) {
      this.deps.onWriteFailed(sessionId, new Error(`the sink refused the row: ${admission.reason}`))
    }
  }

  private take(sessionId: string): Map<string, Row> | undefined {
    const rows = this.queued.get(sessionId)
    this.queued.delete(sessionId)
    return rows
  }
}

/** The record as its row says it. A saved row keeps where it was spawned, and what a record of a
 *  later run no longer carries: its name, its tokens, its parent. */
function subagentRowBlock(
  child: AgentChildWorkRowView,
  id: string,
  parentId: string | undefined,
  saved: NativeChatSubagentBlock | null,
  scope: AgentJournalTurnScope,
  running: boolean
): NativeChatSubagentBlock {
  const run = child.invocation.invocationId
  const state = running ? (child.state === 'idle' ? 'idle' : 'working') : subagentEnding(child)
  const tokens = child.totalTokens ?? saved?.tokens
  const parent = parentId ?? saved?.parentId
  // A new run starts its clock when the host first saw it; the first run when the child was.
  const startedAt =
    saved === null
      ? child.firstObservedAt
      : saved.run === run
        ? (saved.startedAt ?? child.firstObservedAt)
        : child.observedAt
  return {
    type: 'subagent',
    id,
    label: child.description ?? child.name ?? saved?.label ?? UNNAMED,
    state,
    ...(tokens !== undefined ? { tokens } : {}),
    startedAt,
    ...(state !== 'working' && child.settledAt !== undefined ? { settledAt: child.settledAt } : {}),
    groupId: saved?.groupId ?? (scope.kind === 'turn' ? scope.turnItemId : THREAD_GROUP),
    ...(parent !== undefined ? { parentId: parent } : {}),
    run,
    ...(!running && child.outcomeBasis !== undefined ? { outcomeBasis: child.outcomeBasis } : {}),
    ...(child.residency === 'background' ? { background: true as const } : {})
  }
}

function subagentEnding(child: AgentChildWorkRowView): NativeChatSubagentState {
  switch (child.outcome) {
    case 'succeeded':
      return 'completed'
    case 'failed':
      return 'failed'
    case 'cancelled':
      return 'stopped'
    case 'unknown':
    case undefined:
      return 'unverifiable'
  }
}

/** Compared as written, so a row the journal bounded still matches the record it came from. */
function rowText(block: NativeChatSubagentBlock): string {
  return JSON.stringify(subagentJournalBody(block).blocks[1])
}
