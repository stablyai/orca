import { describe, expect, it, vi } from 'vitest'
import { agentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { structuredAgentSessionAttentionPrompts } from '../../agent-session-wire/observations/structured-agent-session-attention-prompts'
import { createLostRequestFixture } from './journal-lost-request-test-fixture'
import {
  pinTestJournalInputMode,
  finishTestJournalHistoricalInputs
} from '../replay/journal-historical-inputs.test-support'
import { journalPersonalStopEvidenceAfter } from '../context-epochs/journal-personal-stop'
import {
  seedLegacyTestJournal,
  openTestJournalHostDatabase
} from './journal-host-database-test-support'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalQuestionItem
} from '../../../../shared/agent-session/journal/agent-session-journal-types'

for (const format of ['raw', 'outcomes'] as const) {
  describe(`lost saved requests in ${format} history`, () => {
    const { fixture, open, lostQuestion } = createLostRequestFixture(format)

    it('restores a positively lost question with its original turn, without reviving execution', async () => {
      const { journal, question, scope } = await lostQuestion()
      await journal.close()
      const restored = await open()
      expect(restored.item(question.itemId)).toMatchObject({
        turnScope: scope,
        body: { kind: 'question', question: 'Which branch?', resolution: { state: 'pending' } }
      })
      expect(restored.newestTurn()).toMatchObject({ state: 'interrupted' })
    })

    it.each(['loss', 'retired-before', 'retired-after'] as const)(
      'checks shared parent revisions at each request opening after %s',
      async (retirement) => {
        if (format === 'raw') {
          seedLegacyTestJournal(openTestJournalHostDatabase(fixture.root), {
            identity: fixture.IDENTITY
          })
        }
        const journal = await open()
        if (format === 'raw') {
          pinTestJournalInputMode(journal)
        }
        const scope = { kind: 'turn' as const, turnItemId: agentJournalItemKey(fixture.item(1)) }
        const turn = async (state: 'running' | 'completed', capturedAt = 1000) =>
          journal.appendItem(
            fixture.item(1),
            {
              kind: 'turn',
              turnId: 'turn-1',
              state,
              contextUsage: { used: { kind: 'unknown', capturedAt } }
            },
            { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
          )
        if (retirement === 'retired-before') {
          await turn('completed')
        }
        await turn('running')
        const pending: AgentJournalQuestionItem = {
          kind: 'question',
          question: 'Which branch?',
          options: [{ id: 'main', label: 'Main' }],
          resolution: {
            state: 'pending',
            selectedOptionId: null,
            resolvedBy: null,
            resolvedAt: null
          }
        }
        for (const ordinal of [2, 3]) {
          await journal.appendItem(fixture.item(ordinal), pending, { fence: 1, turnScope: scope })
        }
        if (retirement === 'retired-after') {
          await turn('completed')
        }
        for (const capturedAt of [1001, 1002, 1003]) {
          await turn('running', capturedAt)
        }
        finishTestJournalHistoricalInputs(journal)
        await journal.appendLifecycleBatch({
          settlementId: 'dead-generation:expected-close:session-1:1:shared-parent',
          fence: 1,
          recovered: true,
          mutations: [
            {
              kind: 'item',
              identity: fixture.item(1),
              body: { kind: 'turn', turnId: 'turn-1', state: 'interrupted' },
              turnScope: AGENT_JOURNAL_THREAD_SCOPE
            },
            ...[2, 3].map((ordinal) => ({
              kind: 'item' as const,
              identity: fixture.item(ordinal),
              body: {
                ...pending,
                resolution: { ...pending.resolution, state: 'cancelled' as const }
              },
              turnScope: scope
            }))
          ]
        })
        await journal.close()
        const restored = await open()
        for (const ordinal of [2, 3]) {
          expect(restored.itemBody(agentJournalItemKey(fixture.item(ordinal)))).toMatchObject({
            resolution: { state: retirement === 'retired-after' ? 'cancelled' : 'pending' }
          })
        }
        expect(restored.newestTurn()).toMatchObject({ state: 'interrupted' })
      }
    )

    it('does not treat an unchanged resolved snapshot as an answer after a later lost question', async () => {
      const { journal, question } = await lostQuestion(false, true, true)
      const earlierId = agentJournalItemKey(fixture.item(4))
      if (format === 'raw') {
        finishTestJournalHistoricalInputs(journal)
      }
      await journal.appendItem(fixture.item(9), fixture.body('Unrelated later update'), {
        fence: 1,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      })
      await journal.close()
      await fixture.withJournalDatabase(fixture.root, (db) => {
        const source = db
          .prepare(
            'SELECT generation, through_seq FROM journal_outcome_epochs WHERE session_id = ?'
          )
          .get('session-1')!
        db.prepare(`INSERT OR REPLACE INTO journal_outcomes (generation, seq, field, entry_key, format, ordinal, value_json, deleted)
          SELECT generation, ?, field, entry_key, format, ordinal, value_json, deleted FROM journal_outcomes
          WHERE generation = ? AND field = 'items' AND entry_key = ? ORDER BY seq DESC LIMIT 1`).run(
          source.through_seq,
          source.generation,
          JSON.stringify(earlierId)
        )
      })
      expect((await open()).itemBody(question.itemId)).toMatchObject({
        resolution: { state: 'pending' }
      })
    })

    it.runIf(format === 'outcomes')(
      'retains loss provenance when a later snapshot repeats the same cancelled revision',
      async () => {
        const { journal, question } = await lostQuestion()
        await journal.appendItem(fixture.item(9), fixture.body('Unrelated update'), {
          fence: 1,
          turnScope: AGENT_JOURNAL_THREAD_SCOPE
        })
        await journal.close()
        await fixture.withJournalDatabase(fixture.root, (db) => {
          const source = db
            .prepare(
              'SELECT generation, through_seq FROM journal_outcome_epochs WHERE session_id = ?'
            )
            .get('session-1')!
          db.prepare(`INSERT INTO journal_outcomes (generation, seq, field, entry_key, format, ordinal, value_json, deleted)
          SELECT generation, ?, field, entry_key, format, ordinal, value_json, deleted FROM journal_outcomes
          WHERE generation = ? AND field = 'items' AND entry_key = ? ORDER BY seq DESC LIMIT 1`).run(
            source.through_seq,
            source.generation,
            JSON.stringify(question.itemId)
          )
        })
        expect((await open()).itemBody(question.itemId)).toMatchObject({
          resolution: { state: 'pending' }
        })
      }
    )

    it.runIf(format === 'outcomes').each(['turn-1', 'other-turn'])(
      'retains a proven %s Stop alongside unrelated unreadable Stop history',
      async (turnId) => {
        const { journal } = await lostQuestion()
        const cursor = journal.cursor()
        await journal.appendStopEvent({ reason: 'user-stop', turnId }, 1)
        await journal.appendStopEvent({ reason: 'user-stop', turnId: 'damaged-turn' }, 1)
        await journal.appendStopEvent({ reason: 'host-stop' }, 1)
        await journal.close()
        await fixture.withJournalDatabase(fixture.root, (db) => {
          db.prepare(`UPDATE journal_outcomes SET value_json = '{'
            WHERE field = '$' AND entry_key = '"queuePauseMarks"'
              AND json_extract(value_json, '$.latestStop.event.turnId') = 'damaged-turn'`).run()
        })
        const database = openTestJournalHostDatabase(fixture.root)
        await database.history?.prepare('session-1')
        expect(
          journalPersonalStopEvidenceAfter(database.db, 'session-1', {
            cursor,
            at: 0,
            turnId: 'turn-1'
          })
        ).toBe(turnId === 'turn-1' ? 'stopped' : 'unknown')
      }
    )

    it.runIf(format === 'outcomes').each(['turn-1', 'other-turn', 'new-message'])(
      'keeps unknown Stop evidence readable and rechecks an exact answer for %s',
      async (stopTurn) => {
        const { journal, pending, scope } = await lostQuestion()
        const saved = await journal.appendItem(fixture.item(8), pending, {
          fence: 1,
          turnScope: scope
        })
        await journal.appendStopEvent(
          { reason: 'user-stop', turnId: stopTurn === 'new-message' ? 'turn-1' : stopTurn },
          1
        )
        await journal.appendStopEvent({ reason: 'host-stop' }, 1)
        await journal.close()
        let damaged: { rowid: number; value_json: string } | undefined
        await fixture.withJournalDatabase(fixture.root, (db) => {
          const row = db
            .prepare(`SELECT rowid, value_json FROM journal_outcomes
            WHERE field = '$' AND entry_key = '"queuePauseMarks"'
              AND json_extract(value_json, '$.latestStop.event.reason') = 'user-stop'
            ORDER BY seq DESC LIMIT 1`)
            .get()!
          damaged = { rowid: Number(row.rowid), value_json: String(row.value_json) }
          db.prepare("UPDATE journal_outcomes SET value_json = '{' WHERE rowid = ?").run(row.rowid)
        })
        const restored = await open()
        expect(restored.itemBody(saved.itemId)).toMatchObject({ resolution: { state: 'pending' } })
        expect(
          restored.personalStopAfter({
            cursor: { epoch: restored.cursor().epoch, sequence: saved.cursor.sequence },
            at: restored.item(saved.itemId)!.observedAt,
            turnId: 'turn-1'
          })
        ).toBe('unknown')
        expect(
          structuredAgentSessionAttentionPrompts(restored, null, () => false).map(
            (item) => item.itemId
          )
        ).toEqual([saved.itemId])
        const input = {
          clientMessageId: 'saved-answer',
          payloadFingerprint: 'saved-answer',
          body: {
            kind: 'message' as const,
            role: 'user' as const,
            blocks: [{ type: 'text' as const, text: 'Main' }]
          },
          fence: 1,
          origin: 'client' as const,
          source: { kind: 'user' as const }
        }
        const answer = {
          itemId: saved.itemId,
          expectedRevision: saved.revision,
          contextEpoch: restored.cursor().epoch,
          identity: fixture.item(8),
          body: {
            ...pending,
            resolution: {
              state: 'resolved' as const,
              selectedOptionId: 'main',
              resolvedBy: 'desktop:user',
              resolvedAt: 1010
            }
          },
          options: { fence: 1, turnScope: scope }
        }
        await expect(
          restored.appendSubmission(input, undefined, undefined, answer)
        ).rejects.toMatchObject({ refusal: { code: 'agent_session_journal_unreadable' } })
        expect(restored.submissions()).toEqual([])
        expect(restored.itemBody(saved.itemId)).toMatchObject({ resolution: { state: 'pending' } })
        if (stopTurn === 'new-message') {
          await restored.appendSubmission({ ...input, clientMessageId: 'new-intent' })
          expect(restored.submissions().map((entry) => entry.clientMessageId)).toEqual([
            'new-intent'
          ])
          return
        }
        openTestJournalHostDatabase(fixture.root)
          .db.prepare('UPDATE journal_outcomes SET value_json = ? WHERE rowid = ?')
          .run(damaged!.value_json, damaged!.rowid)
        if (stopTurn === 'turn-1') {
          await expect(
            restored.appendSubmission(input, undefined, undefined, answer)
          ).rejects.toMatchObject({
            refusal: {
              code: 'agent_session_operation_invalid',
              details: { reason: 'promptOwnerEnded' }
            }
          })
          expect(restored.submissions()).toEqual([])
          expect(structuredAgentSessionAttentionPrompts(restored, null, () => false)).toEqual([])
        } else {
          await restored.appendSubmission(input, undefined, undefined, answer)
          expect(restored.itemBody(saved.itemId)).toMatchObject({
            resolution: { state: 'resolved' }
          })
          expect(restored.submissions().map((entry) => entry.clientMessageId)).toEqual([
            'saved-answer'
          ])
        }
      }
    )

    it.runIf(format === 'outcomes').each([{}, [], { kind: 'unknown-request' }])(
      'keeps an old cancellation ambiguous when superseded request evidence has body %j',
      async (body) => {
        const { journal, question } = await lostQuestion()
        const earlier = await journal.appendItem(
          fixture.item(8),
          { kind: 'status', text: 'Earlier' },
          {
            fence: 1,
            turnScope: AGENT_JOURNAL_THREAD_SCOPE
          }
        )
        await journal.appendItem(
          fixture.item(8),
          { kind: 'status', text: 'Current' },
          {
            fence: 1,
            turnScope: AGENT_JOURNAL_THREAD_SCOPE
          }
        )
        await journal.close()
        const database = openTestJournalHostDatabase(fixture.root)
        database.transaction((db) => {
          const row = db
            .prepare(`SELECT rowid, value_json FROM journal_outcomes
            WHERE field = 'items' AND entry_key = ? ORDER BY seq LIMIT 1`)
            .get(JSON.stringify(earlier.itemId))!
          db.prepare('UPDATE journal_outcomes SET value_json = ? WHERE rowid = ?').run(
            JSON.stringify({ ...JSON.parse(String(row.value_json)), body }),
            row.rowid
          )
        })
        const restored = await open()
        expect(restored.itemBody(earlier.itemId)).toMatchObject({ kind: 'status', text: 'Current' })
        expect(restored.itemBody(question.itemId)).toMatchObject({
          resolution: { state: 'cancelled' }
        })
      }
    )

    it.runIf(format === 'outcomes')(
      'renews a failed loaded proof on the next explicit recovery action',
      async () => {
        const { journal, question } = await lostQuestion()
        await journal.close()
        const database = openTestJournalHostDatabase(fixture.root)
        const failedRead = Promise.withResolvers<boolean>()
        const failure = vi
          .spyOn(database.history!, 'prepareRequests')
          .mockReturnValueOnce(failedRead.promise)
        const restored = await fixture.open()
        const first = restored.restartEvidenceReady()
        failedRead.resolve(false)
        expect(await first).toBe(false)
        expect(restored.itemBody(question.itemId)).toMatchObject({
          resolution: { state: 'cancelled' }
        })
        failure.mockRestore()
        expect(await restored.restartEvidenceReady()).toBe(true)
        expect(restored.itemBody(question.itemId)).toMatchObject({
          resolution: { state: 'pending' }
        })
      }
    )

    it.runIf(format === 'outcomes')(
      'renews unavailable Stop evidence before completing legacy restoration',
      async () => {
        const { journal, question } = await lostQuestion()
        await journal.close()
        const database = openTestJournalHostDatabase(fixture.root)
        await database.history?.prepareRequests('session-1')
        const prepare = database.db.prepare.bind(database.db)
        const failure = vi.spyOn(database.db, 'prepare').mockImplementation((sql) => {
          if (sql.includes('seq > ? AND seq <= ?') && sql.includes('queuePauseMarks')) {
            throw new Error('transient Stop evidence read failure')
          }
          return prepare(sql)
        })
        const restored = await fixture.open()
        expect(await restored.restartEvidenceReady()).toBe(false)
        expect(restored.itemBody(question.itemId)).toMatchObject({
          resolution: { state: 'cancelled' }
        })
        failure.mockRestore()
        expect(await restored.restartEvidenceReady()).toBe(true)
        expect(restored.itemBody(question.itemId)).toMatchObject({
          resolution: { state: 'pending' }
        })
      }
    )

    it.each(format === 'raw' ? (['initial'] as const) : (['initial', 'prepared'] as const))(
      'retries a failed %s restoration write on the next explicit recovery action',
      async (phase) => {
        const { journal, question } = await lostQuestion()
        await journal.close()
        const database = openTestJournalHostDatabase(fixture.root)
        const prepared = Promise.withResolvers<boolean>()
        if (phase === 'initial') {
          await database.history?.prepareRequests('session-1')
        }
        const preparation =
          phase === 'prepared' && format === 'outcomes'
            ? vi.spyOn(database.history!, 'prepareRequests').mockReturnValueOnce(prepared.promise)
            : undefined
        database.db.exec(`CREATE TEMP TRIGGER fail_request_restore BEFORE INSERT ON journal_outcomes
          WHEN json_extract(NEW.value_json, '$.body.kind') = 'question'
            AND json_extract(NEW.value_json, '$.body.resolution.state') = 'pending'
          BEGIN SELECT RAISE(ABORT, 'transient restoration write failure'); END`)
        const restored = await fixture.open()
        const first = restored.restartEvidenceReady()
        prepared.resolve(await database.history!.prepareRequests('session-1'))
        expect(await first).toBe(false)
        expect(restored.itemBody(question.itemId)).toMatchObject({
          resolution: { state: 'cancelled' }
        })
        database.db.exec('DROP TRIGGER fail_request_restore')
        preparation?.mockRestore()
        expect(await restored.restartEvidenceReady()).toBe(true)
        expect(restored.itemBody(question.itemId)).toMatchObject({
          resolution: { state: 'pending' }
        })
      }
    )

    it.each(['clear', 'stopped', 'damaged', 'transient'] as const)(
      'answers from authoritative %s history when optional metadata is unavailable',
      async (history) => {
        const { journal, pending, scope } = await lostQuestion()
        const saved = await journal.appendItem(fixture.item(8), pending, {
          fence: 1,
          turnScope: scope
        })
        if (history === 'stopped' || history === 'damaged') {
          await journal.appendStopEvent({ reason: 'user-stop', turnId: 'turn-1' }, 1)
        }
        await journal.close()
        const database = openTestJournalHostDatabase(fixture.root)
        vi.spyOn(database.history!, 'sourceIdentity').mockReturnValue(null)
        const restored = await fixture.open()
        if (history === 'transient') {
          const prepare = database.db.prepare.bind(database.db)
          let failed = false
          vi.spyOn(database.db, 'prepare').mockImplementation((sql) => {
            if (!failed && sql.includes('seq >= ? AND seq <= ?') && sql.includes('stopEvent')) {
              failed = true
              throw new Error('retirement history temporarily unavailable')
            }
            return prepare(sql)
          })
        }
        if (history === 'damaged') {
          if (format === 'raw') {
            database.db
              .prepare(`UPDATE journal_rows SET row_json = '{'
              WHERE json_extract(row_json, '$.stopEvent.reason') = 'user-stop'`)
              .run()
          } else {
            database.db
              .prepare(`UPDATE journal_outcomes SET value_json = '{'
              WHERE field = '$' AND entry_key = '"queuePauseMarks"'
                AND json_extract(value_json, '$.latestStop.event.reason') = 'user-stop'`)
              .run()
          }
        }
        const input = {
          clientMessageId: 'metadata-free-answer',
          payloadFingerprint: 'answer',
          body: {
            kind: 'message' as const,
            role: 'user' as const,
            blocks: [{ type: 'text' as const, text: 'Main' }]
          },
          fence: 1,
          origin: 'client' as const,
          source: { kind: 'user' as const }
        }
        const answer = {
          itemId: saved.itemId,
          expectedRevision: saved.revision,
          contextEpoch: restored.cursor().epoch,
          identity: fixture.item(8),
          body: {
            ...pending,
            resolution: {
              state: 'resolved' as const,
              selectedOptionId: 'main',
              resolvedBy: 'desktop:user',
              resolvedAt: 1010
            }
          },
          options: { fence: 1, turnScope: scope }
        }
        const answering = restored.appendSubmission(input, undefined, undefined, answer)
        if (history === 'clear') {
          await answering
          expect(restored.itemBody(saved.itemId)).toMatchObject({
            resolution: { state: 'resolved' }
          })
          expect(restored.submissions().map((entry) => entry.clientMessageId)).toEqual([
            'metadata-free-answer'
          ])
        } else {
          await expect(answering).rejects.toMatchObject({
            refusal: {
              code:
                history === 'stopped'
                  ? 'agent_session_operation_invalid'
                  : 'agent_session_journal_unreadable'
            }
          })
          expect(restored.submissions()).toEqual([])
        }
        if (history === 'transient') {
          await restored.appendSubmission(input, undefined, undefined, answer)
          expect(restored.itemBody(saved.itemId)).toMatchObject({
            resolution: { state: 'resolved' }
          })
          expect(restored.submissions().map((entry) => entry.clientMessageId)).toEqual([
            'metadata-free-answer'
          ])
        }
        await restored.appendSubmission({ ...input, clientMessageId: 'ordinary-new-message' })
        expect(restored.submissions().at(-1)?.clientMessageId).toBe('ordinary-new-message')
      }
    )

    it('checks corrected historical Stops before accepting a saved answer from a loaded chat', async () => {
      const { journal, pending, scope } = await lostQuestion()
      const saved = await journal.appendItem(fixture.item(8), pending, {
        fence: 1,
        turnScope: scope
      })
      await journal.appendStopEvent({ reason: 'host-stop' }, 1)
      const stopped = journal.cursor().sequence
      await journal.appendStopEvent({ reason: 'host-stop' }, 1)
      await journal.close()
      const restored = await open()
      const database = openTestJournalHostDatabase(fixture.root)
      database.transaction((db) => {
        if (format === 'raw') {
          db.prepare(`UPDATE journal_rows SET row_json = json_set(row_json,
            '$.stopEvent.reason', 'user-stop', '$.stopEvent.turnId', 'turn-1')
            WHERE session_id = 'session-1' AND seq = ?`).run(stopped)
        } else {
          db.prepare(`UPDATE journal_outcomes SET value_json = json_set(value_json,
            '$.latestStop.event.reason', 'user-stop', '$.latestStop.event.turnId', 'turn-1')
            WHERE field = '$' AND entry_key = '"queuePauseMarks"' AND seq = ?`).run(stopped)
        }
      })
      await expect(
        restored.appendSubmission(
          {
            clientMessageId: 'corrected-stop-answer',
            payloadFingerprint: 'answer',
            body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Main' }] },
            fence: 1,
            origin: 'client',
            source: { kind: 'user' }
          },
          undefined,
          undefined,
          {
            itemId: saved.itemId,
            expectedRevision: saved.revision,
            contextEpoch: restored.cursor().epoch,
            identity: fixture.item(8),
            body: {
              ...pending,
              resolution: {
                state: 'resolved',
                selectedOptionId: 'main',
                resolvedBy: 'desktop:user',
                resolvedAt: 1010
              }
            },
            options: { fence: 1, turnScope: scope }
          }
        )
      ).rejects.toMatchObject({
        refusal: {
          code: 'agent_session_operation_invalid',
          details: { reason: 'promptOwnerEnded' }
        }
      })
      expect(restored.submissions()).toEqual([])
      expect(
        restored.recoveryPersonalStopAfter({
          cursor: { epoch: restored.cursor().epoch, sequence: saved.cursor.sequence },
          at: 0,
          turnId: 'turn-1'
        })
      ).toBe('stopped')
    })

    it('renews a loaded negative proof after a historical personal Stop is corrected', async () => {
      const { journal, question } = await lostQuestion()
      await journal.appendStopEvent({ reason: 'user-stop', turnId: 'turn-1' }, 1)
      const stopped = journal.cursor().sequence
      await journal.appendStopEvent({ reason: 'host-stop' }, 1)
      await journal.close()
      const restored = await open()
      expect(restored.itemBody(question.itemId)).toMatchObject({
        resolution: { state: 'cancelled' }
      })
      const database = openTestJournalHostDatabase(fixture.root)
      database.transaction((db) => {
        if (format === 'raw') {
          db.prepare(`UPDATE journal_rows SET row_json = json_set(row_json, '$.stopEvent.reason', 'host-stop')
            WHERE session_id = 'session-1' AND seq = ?`).run(stopped)
        } else {
          db.prepare(`UPDATE journal_outcomes SET value_json = json_set(value_json, '$.latestStop.event.reason', 'host-stop')
            WHERE field = '$' AND entry_key = '"queuePauseMarks"' AND seq = ?`).run(stopped)
        }
      })
      expect(await restored.restartEvidenceReady()).toBe(true)
      expect(restored.itemBody(question.itemId)).toMatchObject({ resolution: { state: 'pending' } })
    })

    it('keeps the lost question owed after an independent automated turn completes', async () => {
      const { journal, question } = await lostQuestion()
      await journal.appendSubmission({
        clientMessageId: 'recovery',
        payloadFingerprint: 'recovery',
        body: {
          kind: 'message',
          role: 'user',
          blocks: [{ type: 'text', text: 'Continue background work' }]
        },
        origin: 'host',
        fence: 1
      })
      await journal.appendItem(
        fixture.item(3),
        { kind: 'turn', turnId: 'turn-2', state: 'completed' },
        { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
      await journal.close()
      expect((await open()).itemBody(question.itemId)).toMatchObject({
        resolution: { state: 'pending' }
      })
    })

    it.runIf(format === 'outcomes')(
      'keeps a chat readable without treating damaged superseded Stop evidence as absence',
      async () => {
        const { journal, question, pending, scope } = await lostQuestion()
        const saved = await journal.appendItem(fixture.item(8), pending, {
          fence: 1,
          turnScope: scope
        })
        await journal.appendStopEvent({ reason: 'user-stop', turnId: 'other-turn' }, 1)
        await journal.appendStopEvent({ reason: 'host-stop' }, 1)
        const cursor = journal.cursor()
        await journal.close()
        await fixture.withJournalDatabase(fixture.root, (db) => {
          db.prepare(`UPDATE journal_outcomes SET value_json = '{' WHERE rowid = (
            SELECT rowid FROM journal_outcomes WHERE field = '$' AND entry_key = '"queuePauseMarks"'
            ORDER BY seq LIMIT 1)`).run()
        })
        const restored = await open()
        expect(restored.itemBody(saved.itemId)).toMatchObject({ resolution: { state: 'pending' } })
        expect(restored.itemBody(question.itemId)).toMatchObject({
          resolution: { state: 'cancelled' }
        })
        expect(restored.newestTurn()).toMatchObject({ state: 'interrupted' })
        const database = openTestJournalHostDatabase(fixture.root)
        await database.history?.prepare('session-1')
        expect(
          journalPersonalStopEvidenceAfter(database.db, 'session-1', {
            cursor,
            at: 0,
            turnId: 'turn-1'
          })
        ).toBe('unknown')
      }
    )

    it('does not resurrect an ambiguous old question after a later live callback was answered', async () => {
      const { journal, question, pending } = await lostQuestion()
      await journal.appendItem(
        fixture.item(3),
        {
          ...pending,
          resolution: {
            state: 'resolved',
            selectedOptionId: 'main',
            resolvedBy: 'desktop:user',
            resolvedAt: 1010
          }
        },
        { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
      await journal.close()
      expect((await open()).itemBody(question.itemId)).toMatchObject({
        resolution: { state: 'cancelled' }
      })
    })

    it('keeps an ambiguous cancellation when an earlier request was answered after it opened', async () => {
      const { journal, question, pending, scope } = await lostQuestion(false, true)
      await journal.appendItem(
        fixture.item(4),
        {
          ...pending,
          resolution: {
            state: 'resolved',
            selectedOptionId: 'main',
            resolvedBy: 'desktop:user',
            resolvedAt: 1010
          }
        },
        { fence: 1, turnScope: scope }
      )
      await journal.close()
      expect((await open()).itemBody(question.itemId)).toMatchObject({
        resolution: { state: 'cancelled' }
      })
    })

    it('retains a genuine withdrawal even when runtime loss follows it', async () => {
      const { journal, question } = await lostQuestion(true)
      await journal.close()
      expect((await open()).itemBody(question.itemId)).toMatchObject({
        resolution: { state: 'cancelled' }
      })
    })

    it('retains personal Stop when a later host stop replaces the latest stop', async () => {
      const { journal, question } = await lostQuestion()
      await journal.appendStopEvent({ reason: 'user-stop', turnId: 'turn-1' }, 1)
      await journal.appendStopEvent({ reason: 'host-stop' }, 1)
      await journal.close()
      expect((await open()).itemBody(question.itemId)).toMatchObject({
        resolution: { state: 'cancelled' }
      })
    })

    it('does not let a targeted Stop retire a question owned by another turn', async () => {
      const { journal, question } = await lostQuestion()
      await journal.appendStopEvent({ reason: 'user-stop', turnId: 'other-turn' }, 1)
      await journal.close()
      expect((await open()).itemBody(question.itemId)).toMatchObject({
        resolution: { state: 'pending' }
      })
    })

    it('publishes personal Stop only after its transaction commits', async () => {
      const { journal, question } = await lostQuestion()
      const before = journal.cursor()
      const database = openTestJournalHostDatabase(fixture.root).db
      database.exec(`CREATE TRIGGER reject_stop BEFORE INSERT ON ${format === 'raw' ? 'journal_rows' : 'journal_outcomes'}
        BEGIN SELECT RAISE(ABORT, 'stop not saved'); END`)
      await expect(journal.appendStopEvent({ reason: 'user-stop' }, 1)).rejects.toThrow(
        'stop not saved'
      )
      expect(journal.personalStopAfter({ cursor: before, at: 0, turnId: 'turn-1' })).toBe('clear')
      database.exec('DROP TRIGGER reject_stop')
      await journal.close()
      expect((await open()).itemBody(question.itemId)).toMatchObject({
        resolution: { state: 'pending' }
      })
    })

    it('does not revive a request whose original task completed normally', async () => {
      const { journal, question } = await lostQuestion()
      await journal.appendItem(
        fixture.item(1),
        { kind: 'turn', turnId: 'turn-1', state: 'completed' },
        { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
      await journal.close()
      expect((await open()).itemBody(question.itemId)).toMatchObject({
        resolution: { state: 'cancelled' }
      })
    })

    it('does not borrow a lost request marker to explain an earlier unproven parent interruption', async () => {
      const { journal, question } = await lostQuestion(false, false, false, true)
      await journal.close()
      expect((await open()).itemBody(question.itemId)).toMatchObject({
        resolution: { state: 'cancelled' }
      })
    })
  })
}
