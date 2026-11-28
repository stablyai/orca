import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalTurnScope
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { StructuredAgentSessionEventSink } from '../../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import { ensureAgentSessionAttachmentClaimTables } from '../../../native-chat/agent-session-attachments/agent-session-attachment-claims'
import type { JournalStopEvent } from '../../../native-chat/agent-session-journal/durable-rows/journal-row-schema'
import { STOP_DECIDES_FAILURE_MS } from '../../../native-chat/agent-session-journal/context-epochs/journal-stop-turn-end'
import { applyJournalDomainControlCommand } from '../../../native-chat/agent-session-journal/journal-domain-control-command'
import { migrateJournalDomainSchema } from '../../../native-chat/agent-session-journal/journal-domain-schema'
import { journalDomainTimelineReads } from '../../../native-chat/agent-session-journal/journal-domain-timeline-reads'
import { resolveJournalTimelineItem } from '../../../native-chat/agent-session-journal/writing/journal-timeline-resolution'
import Database from '../../../sqlite/sync-database'
import { CodexJournalGenericFrames } from './codex-structured-journal-generic-frames'

// Codex's error row for a failed turn, written by the real frame writer and resolved by the real
// journal writer's view of a saved Stop, as the chat shows it.
const NOW = 1_800_000_000_000
const TURN = 'provider-turn'
const target = { sessionId: 'chat-1', epoch: 'e' }
const SCOPE: AgentJournalTurnScope = { kind: 'turn', turnItemId: 'turn-item' }
let dir = ''
let db: Database
beforeEach(() => {
  vi.useFakeTimers()
  dir = mkdtempSync(join(tmpdir(), 'orca-codex-failure-stop-'))
  db = new Database(join(dir, 'journal.db'))
  migrateJournalDomainSchema(db)
  ensureAgentSessionAttachmentClaimTables(db)
  db.prepare(
    `INSERT INTO journal_chat_state(workspace_id,session_id,epoch,last_sequence,highest_fence)
     VALUES('workspace','chat-1','e',10,1)`
  ).run()
})
afterEach(() => {
  vi.useRealTimers()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const stop = (reason: JournalStopEvent['reason'], at: number, turnId = TURN) => {
  db.exec('BEGIN IMMEDIATE')
  applyJournalDomainControlCommand(
    db,
    target,
    { kind: 'stop-accept', event: { reason }, fence: 1, liveTurnId: turnId },
    {},
    at
  )
  db.exec('COMMIT')
}

/** The chat's rows: what the writer keeps of each of the frame writer's writes. */
function chat() {
  const rows: AgentJournalItemBody[] = []
  const admitted = { accepted: true } as const
  const sink = {
    appendItem: (_identity: unknown, body: AgentJournalItemBody) => {
      rows.push(body)
    },
    tryAppendItem: (_identity: unknown, body: AgentJournalItemBody) => {
      rows.push(body)
      return admitted
    },
    tryReviseResolvedItem: (
      reservedBytes: number,
      resolution: Parameters<typeof resolveJournalTimelineItem>[1]
    ) => {
      const view = journalDomainTimelineReads(db, target)
      const result = resolveJournalTimelineItem(view, resolution, SCOPE, reservedBytes)
      if (result.kind === 'resolved') {
        rows.push(result.item.body)
      }
      return admitted
    },
    appendTombstone: () => {},
    publish: () => {},
    tryPublish: () => admitted
  }
  const frames = new CodexJournalGenericFrames(
    {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the frame writer calls only these sink members.
      sink: sink as unknown as StructuredAgentSessionEventSink,
      acquisitionId: 'acquisition',
      attributionFor: () => ({ turnScope: SCOPE })
    },
    () => TURN
  )
  const errorRows = () => rows.filter((body) => body.kind === 'status' && body.failure)
  return { frames, errorRows }
}

// Codex ends the turn as failed, with the error it hit.
const failedCompletion = {
  threadId: 'thread-1',
  turn: { id: TURN, status: 'failed', error: { message: 'stream disconnected before completion' } }
}
// Codex's own error notice for the turn, before it completes.
const errorNotice = {
  threadId: 'thread-1',
  turnId: TURN,
  willRetry: false,
  error: { message: 'stream disconnected before completion' }
}

/** The error rows the chat shows after a failed turn ending at `at`. */
function shownAfterFailure(at: number, frame: 'completion' | 'notice' = 'completion') {
  vi.setSystemTime(at)
  const { frames, errorRows } = chat()
  if (frame === 'completion') {
    frames.appendCompletionFailure(failedCompletion, 'thread-1', () => {})
  } else {
    frames.appendUnhandled('notification:error', errorNotice, 'thread-1')
  }
  return errorRows()
}

describe('a person stops a Codex turn that Codex then reports as failed', () => {
  it('shows no error row for the failed completion', () => {
    stop('user-stop', NOW)
    expect(shownAfterFailure(NOW + 2_000)).toEqual([])
  })

  it('shows no error row for its error notice either', () => {
    stop('user-stop', NOW)
    expect(shownAfterFailure(NOW + 1_000, 'notice')).toEqual([])
  })

  it('shows none when the person closed the chat on it', () => {
    stop('user-close', NOW)
    expect(shownAfterFailure(NOW + 1_000)).toEqual([])
  })
})

describe('a real Codex failure keeps its error row', () => {
  it('with no Stop', () => {
    expect(shownAfterFailure(NOW)).toHaveLength(1)
  })

  it('when it fails long after the Stop', () => {
    stop('user-stop', NOW)
    expect(shownAfterFailure(NOW + STOP_DECIDES_FAILURE_MS + 1)).toHaveLength(1)
  })

  it('when it failed before the Stop', () => {
    stop('user-stop', NOW)
    expect(shownAfterFailure(NOW - 1)).toHaveLength(1)
  })

  it('when the Stop was for another turn', () => {
    stop('user-stop', NOW, 'earlier-turn')
    expect(shownAfterFailure(NOW + 1_000)).toHaveLength(1)
  })

  it('when Orca, not a person, stopped it', () => {
    stop('host-stop', NOW)
    expect(shownAfterFailure(NOW + 1_000)).toHaveLength(1)
  })
})
