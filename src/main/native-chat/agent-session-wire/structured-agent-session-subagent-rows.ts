// Mirror host subagent records into durable rows, deduplicating against saved content.
// Failed writes retry on the next change; reopen settles any stale working rows as unverifiable.
// Use the reporting child’s sink so resumed work belongs to its new execution owner.

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

export type AgentChildWorkRowView = AgentChildWorkView &
  Pick<AgentChildWorkInput, 'outcomeBasis' | 'residency'>

/** Writes through the reporting child’s sink and fence. */
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
  /** First rows join current work; revisions retain their original scope. */
  currentWork: (
    sessionId: string,
    journal: AgentSessionJournal
  ) => Pick<StructuredAgentSessionCurrentWork, 'turnScope'>
  readChildWork: (sessionId: string) => AgentChildWorkRowView[] | undefined
  onWriteFailed: (sessionId: string, error: unknown) => void
}

export class StructuredAgentSessionSubagentRows {
  private readonly queued = new Map<string, Map<string, Row>>()
  /** In-flight writes not yet readable by key. */
  private readonly writing = new Map<string, Map<string, Row>>()
  /** Running rows already written by each child, proving execution ownership. */
  private readonly claimed = new WeakMap<StructuredAgentSessionChildWorkProducer, Set<string>>()

  constructor(private readonly deps: StructuredAgentSessionSubagentRowsDeps) {}

  /** Queue changed rows and unchanged running rows the reporting child has not claimed. */
  changed(sessionId: string, producer?: StructuredAgentSessionChildWorkProducer): void {
    const journal = this.deps.journal(sessionId)
    const children = this.deps.readChildWork(sessionId)
    if (!journal || !children?.some((child) => child.kind === 'agent')) {
      return
    }
    const queued = this.queued.get(sessionId) ?? new Map<string, Row>()
    const claimed = producer && (this.claimed.get(producer) ?? new Set<string>())
    const providerIds = new Map(children.map((child) => [child.id, child.providerId]))
    // Helpers remain running while work they started still runs.
    const running = new Set(structuredRunningChildWork(children).map((child) => child.id))
    // Read current scope only for first writes; revisions retain immutable scope.
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
      // Unchanged running rows still need a write to transfer execution ownership to this child.
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
        // Reopen settles stale work when no writable journal remains.
        if (!journal) {
          return
        }
        this.writing.set(sessionId, rows)
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

  /** Retry backpressure after drain; any failure releases the execution claim. */
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

/** Retain saved name, tokens and parent when a later run lacks them. */
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
  // Later runs start at first observation; the initial run starts at child creation.
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

/** Compare bounded persisted content to avoid rewriting forever after journal truncation. */
function rowText(block: NativeChatSubagentBlock): string {
  return JSON.stringify(subagentJournalBody(block).blocks[1])
}
