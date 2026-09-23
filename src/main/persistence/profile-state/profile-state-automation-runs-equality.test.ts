import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { clearProfileStateAutomationRuns } from './profile-state-automation-runs'
import { openProfileStateDatabase } from './profile-state-database'
import {
  hashProfileStateJson,
  importProfileStateJson,
  readProfileStateRevision,
  readProfileStateSnapshot
} from './profile-state-documents'
import { writeProfileStateDomains } from './profile-state-domain-writes'

const databases: { db: ReturnType<typeof openProfileStateDatabase>['db']; directory: string }[] = []

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'orca-history-equality-'))
  const { db } = openProfileStateDatabase(join(directory, 'state.db'), 'profile')
  const runs = [{ id: 'run', extension: { content: '雪 🐋' } }]
  const payload = JSON.stringify(runs)
  importProfileStateJson(db, JSON.stringify({ settings: {}, automationRuns: runs }))
  const result = { db, directory, runs, payload }
  databases.push(result)
  return result
}

afterEach(() => {
  for (const { db, directory } of databases.splice(0)) {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('automation history replacement equality', () => {
  it.each([false, true])(
    'keeps revision and timestamp for equal history (whitespace: %s)',
    (spaces) => {
      const { db, payload, runs } = fixture()
      const before = readProfileStateSnapshot(db)

      expect(
        writeProfileStateDomains(db, {
          expectedRevision: 1,
          replacements: [
            {
              domain: 'automationRuns',
              payload: spaces ? JSON.stringify(runs, null, 2) : payload,
              now: () => {
                throw new Error('An unchanged replacement must not request a timestamp')
              }
            }
          ]
        })
      ).toEqual({ changed: false, revision: 1, changedDomains: [] })
      expect(readProfileStateSnapshot(db)).toEqual(before)
    }
  )

  it('fences a stale caller even when its history still matches', () => {
    const { db, payload } = fixture()
    writeProfileStateDomains(db, {
      expectedRevision: 1,
      replacements: [{ domain: 'settings', payload: '{"theme":"dark"}' }]
    })

    expect(() =>
      writeProfileStateDomains(db, {
        expectedRevision: 1,
        replacements: [{ domain: 'automationRuns', payload }]
      })
    ).toThrow(expect.objectContaining({ code: 'profile-state-revision-conflict' }))
    expect(readProfileStateRevision(db)).toBe(2)
  })

  it('rejects malformed JSON before trusting an equal stored hash', () => {
    const { db } = fixture()
    db.prepare('UPDATE profile_state_automation_runs_meta SET content_hash = ?').run(
      hashProfileStateJson('[')
    )

    expect(() =>
      writeProfileStateDomains(db, {
        expectedRevision: 1,
        replacements: [{ domain: 'automationRuns', payload: '[' }]
      })
    ).toThrow('Profile state domain payload is invalid JSON: automationRuns')
    expect(db.isTransaction).toBe(false)
    expect(readProfileStateRevision(db)).toBe(1)
  })

  it('normalizes an equal document payload when normalized storage is not established', () => {
    const { db, payload } = fixture()
    clearProfileStateAutomationRuns(db)
    db.prepare(
      "UPDATE profile_state_documents SET payload = ?, content_hash = ? WHERE domain = 'automationRuns'"
    ).run(payload, hashProfileStateJson(payload))
    const before = readProfileStateSnapshot(db)

    expect(
      writeProfileStateDomains(db, {
        expectedRevision: 1,
        replacements: [{ domain: 'automationRuns', payload }]
      })
    ).toEqual({ changed: true, revision: 2, changedDomains: ['automationRuns'] })
    expect(readProfileStateSnapshot(db).json).toBe(before.json)
    expect(db.prepare('SELECT presence FROM profile_state_automation_runs_meta').get()).toEqual({
      presence: 'array'
    })
  })

  it('rejects a corrupt document placeholder before accepting equal normalized history', () => {
    const { db, payload } = fixture()
    db.prepare(
      "UPDATE profile_state_documents SET payload = 'true' WHERE domain = 'automationRuns'"
    ).run()

    expect(() =>
      writeProfileStateDomains(db, {
        expectedRevision: 1,
        replacements: [{ domain: 'automationRuns', payload }]
      })
    ).toThrow('Profile state document hash mismatch: automationRuns')
    expect(readProfileStateRevision(db)).toBe(1)
  })
})
