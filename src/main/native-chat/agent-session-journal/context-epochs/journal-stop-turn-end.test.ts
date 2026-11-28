import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentJournalTurnItem
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { connectorReplyTurnOutcome } from '../../../../shared/agent-session/journal/journal-connector-reply-turn'
import { claudeTurnEndForResult } from '../../../claude/structured/turns/claude-turn-lifecycle-item'
import {
  codexTurnLifecycleState,
  codexTurnOutcome
} from '../../../codex/structured/journal/codex-structured-journal-translation-turns'
import { outcomeSentence } from '../../../connector-cloud/connector-reply-outcome-sentence'
import { ensureAgentSessionAttachmentClaimTables } from '../../agent-session-attachments/agent-session-attachment-claims'
import Database from '../../../sqlite/sync-database'
import type { JournalStopEvent } from '../durable-rows/journal-row-schema'
import { applyJournalDomainControlCommand } from '../journal-domain-control-command'
import { normalizeJournalDomainItemBody } from '../journal-domain-item-normalization'
import { migrateJournalDomainSchema } from '../journal-domain-schema'
import { STOP_DECIDES_FAILURE_MS } from './journal-stop-turn-end'

// The real journal writer's Stop and its write-time turn-end rule, with each provider's own end.
const NOW = 1_800_000_000_000
const target = { sessionId: 'chat-1', epoch: 'e' }
let dir = ''
let db: Database
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-stop-turn-end-'))
  db = new Database(join(dir, 'journal.db'))
  migrateJournalDomainSchema(db)
  ensureAgentSessionAttachmentClaimTables(db)
  db.prepare(
    `INSERT INTO journal_chat_state(workspace_id,session_id,epoch,last_sequence,highest_fence)
     VALUES('workspace','chat-1','e',10,1)`
  ).run()
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const stop = (reason: JournalStopEvent['reason'], at: number, turnId = 'provider-turn') => {
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

const RUNNING: AgentJournalTurnItem = {
  kind: 'turn',
  turnId: 'provider-turn',
  state: 'running',
  startedAt: NOW - 60_000
}

const row = (body: AgentJournalTurnItem, revision = 1): AgentJournalRenderItem => ({
  itemId: 'turn-item',
  revision,
  sequence: 5,
  observedAt: body.completedAt ?? NOW,
  body
})

/** The turn's end as the journal saves it over its running row. */
const saved = (end: AgentJournalTurnItem, previous: AgentJournalTurnItem = RUNNING) =>
  normalizeJournalDomainItemBody(db, target, row(end, 2), row(previous))

// Codex reports its own end; a `failed` one is completed with a failure verdict.
const codexEnd = (status: string, completedAt: number): AgentJournalTurnItem => {
  const outcome = codexTurnOutcome(status)
  return {
    ...RUNNING,
    state: codexTurnLifecycleState(status),
    ...(outcome ? { outcome } : {}),
    completedAt
  }
}

// Claude's error result with no Stop deferral: completed with a failure verdict.
const CLAUDE_ERROR = { type: 'result', subtype: 'error_during_execution', is_error: true }
const claudeErrorEnd = (completedAt: number): AgentJournalTurnItem => ({
  ...RUNNING,
  ...claudeTurnEndForResult(CLAUDE_ERROR, completedAt)
})

/** What the thread hears for the turn: its reply outcome, and the host's own words for it. */
const thread = (body: ReturnType<typeof saved>) => {
  const turn = body.kind === 'turn' ? body : null
  const { outcome } = connectorReplyTurnOutcome({
    outcome: turn?.outcome ?? 'success',
    prose: '',
    bot: true
  })
  return { outcome, words: outcomeSentence(outcome, 'Mac') }
}

describe('a person stops a turn that the agent then reports as failed', () => {
  it('reads a Codex turn the Stop ended as stopped, not an error', () => {
    stop('user-stop', NOW)
    const end = saved(codexEnd('failed', NOW + 2_000))
    expect(end).toMatchObject({ state: 'interrupted', outcome: 'cancellation' })
    expect(thread(end)).toEqual({ outcome: 'cancelled', words: 'Stopped on Mac.' })
  })

  it('reads a Claude turn the Stop ended as stopped, not an error', () => {
    stop('user-stop', NOW)
    const end = saved(claudeErrorEnd(NOW + 2_000))
    expect(end).toMatchObject({ state: 'interrupted', outcome: 'cancellation' })
    expect(thread(end)).toEqual({ outcome: 'cancelled', words: 'Stopped on Mac.' })
  })

  it('reads a turn a person closed the chat on as stopped', () => {
    stop('user-close', NOW)
    expect(saved(codexEnd('failed', NOW + 1_000))).toMatchObject({ outcome: 'cancellation' })
  })

  it('keeps that verdict when the same end is written again', () => {
    stop('user-stop', NOW)
    const first = saved(codexEnd('failed', NOW + 2_000))
    if (first.kind !== 'turn') {
      throw new Error('the turn end was not saved as a turn')
    }
    const again = saved(codexEnd('failed', NOW + 2_000), first)
    expect(again).toMatchObject({ state: 'interrupted', outcome: 'cancellation' })
  })
})

describe('a real failure keeps its error', () => {
  it('with no Stop, for Codex and Claude', () => {
    for (const end of [codexEnd('failed', NOW), claudeErrorEnd(NOW)]) {
      const body = saved(end)
      expect(body).toMatchObject({ state: 'completed', outcome: 'failure' })
      expect(thread(body).outcome).toBe('failed')
    }
  })

  it('when it fails long after the Stop', () => {
    stop('user-stop', NOW)
    const late = NOW + STOP_DECIDES_FAILURE_MS + 1
    expect(saved(codexEnd('failed', late))).toMatchObject({ outcome: 'failure' })
    expect(saved(claudeErrorEnd(late))).toMatchObject({ outcome: 'failure' })
  })

  it('when it failed before the Stop', () => {
    stop('user-stop', NOW)
    expect(saved(codexEnd('failed', NOW - 1))).toMatchObject({ outcome: 'failure' })
  })

  it('when the Stop was for another turn', () => {
    stop('user-stop', NOW, 'earlier-turn')
    expect(saved(codexEnd('failed', NOW + 1_000))).toMatchObject({ outcome: 'failure' })
  })

  it('when Orca, not a person, stopped it', () => {
    stop('host-stop', NOW)
    expect(saved(codexEnd('failed', NOW + 1_000))).toMatchObject({ outcome: 'failure' })
  })

  it('and a success the Stop raced stays a success', () => {
    stop('user-stop', NOW)
    expect(saved(codexEnd('completed', NOW + 1_000))).toMatchObject({ outcome: 'success' })
  })
})
