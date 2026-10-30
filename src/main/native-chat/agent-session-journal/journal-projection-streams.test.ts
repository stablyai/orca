import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import {
  codexProviderHandle,
  claudeProviderHandle
} from '../../../shared/agent-session-provider-handle-encoding'
import { createClaudeJournalTranslator } from '../../claude/claude-structured-journal-translation'
import { createCodexJournalTranslator } from '../../codex/codex-structured-journal-translation'
import { createDeferredStructuredAgentSessionEventSink } from '../agent-session-wire/structured-agent-session-event-sink'
import {
  createTrackedJournalOpener,
  openTestJournalHostDatabase
} from './journal-host-database-test-support'
import { clearJournalSavedState, readJournalSavedState } from './journal-saved-state'
import { renderJournalState } from './journal-reducer'
import { JournalProjectionCatchUp } from './journal-projection-catch-up'
import {
  expectProjectionMatches,
  replayedPrefixCoverage,
  unpacedCatchUp
} from './journal-projection-test-support'
import type { JournalHostDatabase } from './journal-host-database'

const sessionId = 'session-1'
let root: string
let database: JournalHostDatabase
const journals = createTrackedJournalOpener()
const disposals: (() => void)[] = []
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journal-projection-streams-'))
  database = openTestJournalHostDatabase(root)
})
afterEach(async () => {
  for (const dispose of disposals.splice(0)) {
    dispose()
  }
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

const claudeCapture = z.object({
  kind: z.string(),
  at: z.number(),
  frame: z.record(z.string(), z.unknown()).optional()
})
const codexCapture = z.object({
  case: z.string(),
  t: z.number(),
  method: z.string(),
  params: z.record(z.string(), z.unknown())
})
function lines(path: URL): unknown[] {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
}

it.each(['claude', 'codex'] as const)(
  'projects every commit of a captured %s stream, revisions and Stop settlement',
  async (agent) => {
    let at = 1_000
    const identity: AgentSessionJournalIdentity = {
      sessionId,
      workspaceId: 'workspace',
      hostId: 'host',
      agent,
      providerHandle:
        agent === 'codex' ? codexProviderHandle('thread-1') : claudeProviderHandle('claude-1', null)
    }
    const journal = await journals.open({ identity, stateDirectory: root, now: () => at })
    let commits = 0
    let planRevisions = 0
    journal.observeCommits((rows) => {
      if (!rows?.length) {
        return
      }
      commits++
      planRevisions += rows.filter(
        (row) =>
          row.kind === 'item' &&
          row.body.kind === 'status' &&
          row.body.providerFrame?.kind === 'notification:turn/plan/updated'
      ).length
      const saved = readJournalSavedState(database.db, sessionId, journal.epoch)
      expect(saved?.lastSequence).toBe(journal.cursor().sequence)
      if (!saved) {
        throw new Error('missing write-time projection')
      }
      expectProjectionMatches(database, saved)
      expect(renderJournalState(saved)).toStrictEqual(journal.snapshot())
    })
    const failed = vi.fn()
    const sink = createDeferredStructuredAgentSessionEventSink({
      sessionId,
      logger: { warn: vi.fn(), error: vi.fn() },
      onFailed: failed
    })
    disposals.push(() => sink.close())
    sink.bind({ journal, fence: 1, publish: () => undefined })
    const pending = new Set<() => void>()
    const schedule = (run: () => void) => {
      pending.add(run)
      return () => {
        pending.delete(run)
      }
    }
    const flush = async (translator: { flush: () => void }) => {
      translator.flush()
      const runs = Array.from(pending)
      pending.clear()
      for (const run of runs) {
        run()
      }
      expect(await sink.drained()).toEqual({ ok: true })
    }
    if (agent === 'claude') {
      const translator = createClaudeJournalTranslator({ sink: sink.sink, schedule })
      disposals.push(() => translator.dispose())
      const capture = lines(
        new URL('../../claude/__fixtures__/claude-adapter-capture-miss.jsonl', import.meta.url)
      ).map((line) => claudeCapture.parse(line))
      for (const record of capture) {
        if (!record.frame) {
          continue
        }
        at = 1_000 + record.at
        translator.handle({ type: 'message', sessionId, message: record.frame, observedAt: at })
        await flush(translator)
      }
    } else {
      const translator = createCodexJournalTranslator({ sink: sink.sink, schedule, now: () => at })
      disposals.push(() => translator.dispose())
      const capture = lines(
        new URL('../../codex/__fixtures__/codex-app-server-turn-endings.jsonl', import.meta.url)
      )
        .map((line) => codexCapture.parse(line))
        .filter((record) => record.case === '0.158.0-control')
      expect(capture.length).toBeGreaterThan(0)
      let threadId = 'thread-1'
      let turnId = 'turn-1'
      for (const record of capture) {
        at = 1_000 + record.t
        if (typeof record.params.threadId === 'string') {
          threadId = record.params.threadId
        }
        if (record.method === 'turn/started') {
          const turn = z.object({ id: z.string() }).parse(record.params.turn)
          turnId = turn.id
        }
        if (record.method === 'turn/completed') {
          for (const status of ['inProgress', 'completed']) {
            translator.handle({
              type: 'notification',
              sessionId,
              threadId,
              method: 'turn/plan/updated',
              params: { threadId, turnId, plan: [{ step: 'Verify saved state', status }] }
            })
            await flush(translator)
          }
        }
        translator.handle({
          type: 'notification',
          sessionId,
          threadId,
          method: record.method,
          params: record.params,
          observedAt: at
        })
        await flush(translator)
      }
      expect(planRevisions).toBeGreaterThanOrEqual(2)
    }
    expect(failed).not.toHaveBeenCalled()
    // Most codex capture records write no row; it commits three times.
    expect(commits).toBeGreaterThanOrEqual(agent === 'claude' ? 6 : 3)
    const stoppedTurn = { provider: 'orca', clientMessageId: 'stopped-turn' } as const
    await journal.appendItem(
      stoppedTurn,
      { kind: 'turn', turnId: 'stop-turn', state: 'running' },
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    await journal.appendStopEvent({ reason: 'user-stop', turnId: 'stop-turn' }, 1)
    const settle = journal.stopMarks.beginSettle(true)
    await journal.appendLifecycleBatch({
      settlementId: 'stop-settlement',
      fence: 1,
      mutations: [
        {
          kind: 'item',
          identity: stoppedTurn,
          body: { kind: 'turn', turnId: 'stop-turn', state: 'interrupted', completedAt: at + 1 },
          turnScope: AGENT_JOURNAL_THREAD_SCOPE
        }
      ]
    })
    expect(journal.stopMarks.latest()?.settle).toBe(settle)
    journal.stopMarks.settled(settle)
    expect(
      readJournalSavedState(database.db, sessionId, journal.epoch)?.appliedSettlementIds.has(
        'stop-settlement'
      )
    ).toBe(true)

    // Catch the same history up from no saved view, one row per page: every committed prefix and
    // its tail fold to the full replay, through aliases, settlements and per-row timestamps.
    database.transaction((db) => clearJournalSavedState(db, sessionId))
    const catchUp = new JournalProjectionCatchUp(database, sessionId, journal.epoch, 1)
    expect(await catchUp.load(unpacedCatchUp)).toBe('ready')
    const prefixes: (number | null)[] = []
    while (catchUp.page() === 'advanced') {
      prefixes.push(replayedPrefixCoverage(database, sessionId))
    }
    expect(prefixes).toStrictEqual(
      Array.from({ length: journal.cursor().sequence }, (_, index) => index + 1)
    )

    // Count actual SQLite writes on a revision after many entities already exist.
    database.db.exec(`CREATE TEMP TABLE projection_bytes (field TEXT, bytes INTEGER);
    CREATE TEMP TRIGGER item_revision_bytes AFTER UPDATE ON journal_items BEGIN
      INSERT INTO projection_bytes VALUES ('item', length(CAST(NEW.item_json AS BLOB))); END;
    CREATE TEMP TRIGGER scalar_revision_bytes AFTER UPDATE ON journal_state BEGIN
      INSERT INTO projection_bytes VALUES ('state', length(CAST(NEW.state_json AS BLOB))); END;
    CREATE TEMP TRIGGER entry_revision_bytes AFTER UPDATE ON journal_entries BEGIN
      INSERT INTO projection_bytes VALUES ('entry', length(CAST(NEW.entry_json AS BLOB))); END`)
    const changed = { provider: 'orca', clientMessageId: 'streamed-measurement' } as const
    await journal.appendItem(
      changed,
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'x'.repeat(16_384) }] },
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    database.db.exec('DELETE FROM projection_bytes')
    await journal.appendItem(
      changed,
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'y'.repeat(16_384) }] },
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    expect(
      database.db.prepare("SELECT COUNT(*) AS n FROM projection_bytes WHERE field = 'item'").get()
        ?.n
    ).toBe(1)
    const projectedBytes = Number(
      database.db.prepare('SELECT SUM(bytes) AS n FROM projection_bytes').get()?.n
    )
    const rowBytes = Number(
      database.db
        .prepare(
          'SELECT length(CAST(row_json AS BLOB)) AS n FROM journal_rows WHERE session_id = ? AND epoch = ? AND seq = ?'
        )
        .get(sessionId, journal.epoch, journal.cursor().sequence)?.n
    )
    expect((rowBytes + projectedBytes) / rowBytes).toBeLessThan(3)
  }
)
