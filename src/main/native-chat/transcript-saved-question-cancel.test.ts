import { appendFile, writeFile } from 'node:fs/promises'
import { expect, it, vi } from 'vitest'
import { failQuestionReadAfterTargetCommit } from './message-question-read-failure.test-fixture'
import { JournalHostDatabase } from './agent-session-journal/journal-host-database'
import { messageQuestionsFor } from './message-question-repository'
import * as versions from './transcript-file-version'
import { cancelTranscriptCurrentQuestions } from './transcript-current-questions'
import { fixture, question, output } from './transcript-current-questions-test-fixture'
import {
  clearRow,
  stopRow,
  decodeWithClear,
  sourceQuery
} from './transcript-current-questions-source-test-fixture'

it.each(['cancel', 'delivery-stop', 'delivery-clear', 'target-write', 'postcommit-read'] as const)(
  'admits terminal saved-target action with unrelated Q2 INSERT failure: %s',
  async (kind) => {
    if (kind === 'postcommit-read') {
      vi.useFakeTimers()
    }
    const f = await fixture()
    const q = sourceQuery(f, `saved-target-${kind}`, decodeWithClear)
    await writeFile(f.path, question('q1'))
    await q.read()
    const displayed = f.repository.current(q.source).pending[0].id
    const cancel = (ids = [displayed]) =>
      cancelTranscriptCurrentQuestions(
        f.path,
        'codex',
        q.source.sessionId,
        decodeWithClear,
        ids,
        'phone',
        7,
        undefined,
        f.repository
      )
    f.database.db.exec(`CREATE TEMP TRIGGER fail_q2 BEFORE INSERT ON message_question_occurrences
      WHEN NEW.occurrence_id <> '${displayed}' BEGIN SELECT RAISE(ABORT, 'Q2 insert failure'); END`)
    await expect(cancel([displayed, 'foreign'])).rejects.toThrow('does not belong')
    const version = versions.readTranscriptFileVersion
    let release!: () => void
    let entered!: () => void
    const delivery = new Promise<void>((resolve) => {
      release = resolve
    })
    const dispatched = new Promise<void>((resolve) => {
      entered = resolve
    })
    vi.spyOn(versions, 'readTranscriptFileVersion').mockImplementationOnce(async (...args) => {
      entered()
      await delivery
      return version(...args)
    })
    if (kind === 'target-write') {
      f.database.db.exec(
        "CREATE TEMP TRIGGER fail_update BEFORE UPDATE ON message_question_occurrences BEGIN SELECT RAISE(ABORT, 'target update failure'); END"
      )
    }
    const sourceRead =
      kind === 'postcommit-read'
        ? failQuestionReadAfterTargetCommit(f.database.db, displayed)
        : undefined
    const concurrentRead = kind === 'cancel' ? q.read() : undefined
    const receipt = cancel()
    void receipt.catch(() => {})
    await dispatched
    try {
      if (kind.startsWith('delivery')) {
        await appendFile(
          f.path,
          output('human-delivery', 'user') +
            (kind === 'delivery-clear' ? clearRow('clear') : stopRow('stop'))
        )
      }
      await appendFile(f.path, question('q2'))
      release()
      const target = () =>
        f.repository.current(q.source).records.find((record) => record.id === displayed)
      if (kind === 'target-write') {
        await expect(receipt).rejects.toThrow('target update failure')
        expect(target()?.resolution.state).toBe('pending')
        f.database.db.exec('DROP TRIGGER fail_update')
        await cancel()
      } else {
        await expect(receipt).resolves.toBeUndefined()
        if (sourceRead) {
          const unavailable = await q.read()
          expect(
            unavailable.items &&
              !Array.isArray(unavailable.items) &&
              unavailable.items.asyncQuestions
          ).toBe(null)
          expect(sourceRead.failedReads()).toBeGreaterThan(0)
          sourceRead.restore()
        }
        expect(target()?.resolution).toMatchObject(
          kind.startsWith('delivery')
            ? { state: 'resolved', reason: 'delivery', factId: 'human-delivery' }
            : { state: 'cancelled', reason: 'user' }
        )
      }
      await concurrentRead
      expect(
        f.repository.current(q.source).records.some((record) => record.sourceRowId === 'q2')
      ).toBe(false)
      const after = await q.read()
      expect(after.items && !Array.isArray(after.items) && after.items.asyncQuestions).toBe(null)
      f.database.db.exec('DROP TRIGGER fail_q2')
      const complete = await q.read()
      expect(
        complete.items &&
          !Array.isArray(complete.items) &&
          complete.items.asyncQuestions?.map((record) => record.sourceRowId)
      ).toEqual(['q2'])
      expect(target()?.resolution.state).not.toBe('pending')
      if (kind === 'postcommit-read') {
        const resolution = target()?.resolution
        // Ordinary idle disposal ends registry interest, then a genuinely reopened DB/source rederives state.
        await vi.advanceTimersByTimeAsync(30_001)
        const directory = f.database.stateDirectory
        f.database.close()
        f.database = JournalHostDatabase.open(directory)
        f.repository = messageQuestionsFor(f.database)
        const reopened = await q.read()
        expect(reopened.marker.publisher).not.toBe(complete.marker.publisher)
        expect(
          reopened.items &&
            !Array.isArray(reopened.items) &&
            reopened.items.asyncQuestions?.map((record) => record.sourceRowId)
        ).toEqual(['q2'])
        expect(target()?.resolution).toEqual(resolution)
      }
    } finally {
      release()
      sourceRead?.restore()
      await receipt.catch(() => {})
      f.database.db.exec('DROP TRIGGER IF EXISTS fail_q2; DROP TRIGGER IF EXISTS fail_update')
    }
  }
)
