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
import { restoreJournal } from './journal-open'
import { applyJournalRow, renderJournalState } from './journal-reducer'
import {
  expectProjectionMatches,
  projectionBase,
  projectionEpochRow,
  projectionWriter,
  seedOutcomeRows,
  seedProjectionRows
} from './journal-projection-test-support'
import type { JournalHostDatabase } from './journal-host-database'
import type { JournalRow } from './journal-row-schema'

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
    const expected = restoreJournal(database.db, sessionId)!.state
    let commits = 0
    let planRevisions = 0
    journal.observeCommits((rows) => {
      if (!rows?.length) {
        return
      }
      for (const row of rows) {
        applyJournalRow(expected, row, at)
      }
      commits++
      planRevisions += rows.filter(
        (row) =>
          row.kind === 'item' &&
          row.body.kind === 'status' &&
          row.body.providerFrame?.kind === 'notification:turn/plan/updated'
      ).length
      const saved = restoreJournal(database.db, sessionId)?.state
      expect(saved?.lastSequence).toBe(journal.cursor().sequence)
      if (!saved) {
        throw new Error('missing saved chat')
      }
      expectProjectionMatches(database, expected)
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
      restoreJournal(database.db, sessionId)?.state.appliedSettlementIds.has('stop-settlement')
    ).toBe(true)
  }
)

// One row may remove an item, add another, then re-create the first above its tombstone: the
// re-created item moves after the new one, live and saved alike, whether the first came from the
// chat's records or from its frozen input prefix.
it.each(['written', 'over a prefix'] as const)(
  'keeps live order for a key deleted and re-created around a new key in one %s row',
  async (path) => {
    const item = (itemId: string, revision: number) => ({
      kind: 'item' as const,
      itemId,
      revision,
      body: { kind: 'status' as const, text: `${itemId} ${revision}` }
    })
    const first: JournalRow = { ...projectionBase(2), ...item('x', 1) }
    const batch: JournalRow = {
      ...projectionBase(3),
      kind: 'lifecycle-batch',
      settlementId: 'reorder',
      mutations: [{ kind: 'tombstone', itemId: 'x', revision: 2 }, item('y', 1), item('x', 3)]
    }
    const rig = projectionWriter(
      database,
      path === 'written'
        ? seedOutcomeRows(database, [projectionEpochRow, first])
        : seedProjectionRows(database, [projectionEpochRow, first])
    )
    await rig.writer.enqueue((seq, ts) => ({ ...batch, seq, ts }))
    expect([...rig.state().items.keys()]).toEqual(['y', 'x'])
    expectProjectionMatches(database, rig.state())
  }
)
