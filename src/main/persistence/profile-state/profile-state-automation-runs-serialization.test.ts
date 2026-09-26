import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildProfileStateCutoverFixture } from '../profile-state-cutover-fixture'
import { openProfileStateDatabase } from './profile-state-database'
import { importProfileStateJson, readProfileStateSnapshot } from './profile-state-documents'
import { writeProfileStateDomains } from './profile-state-domain-writes'

describe('automation history serialization', () => {
  it.each(['import', 'replacement', 'delta'] as const)(
    'preserves JSON ordering, escaping and unknown fields through %s',
    (operation) => {
      const directory = mkdtempSync(join(tmpdir(), 'orca-automation-run-serialization-'))
      const { db } = openProfileStateDatabase(join(directory, 'state.db'), 'profile')
      try {
        const fixtureRun = buildProfileStateCutoverFixture().automationRuns[0]
        if (!fixtureRun) {
          throw new Error('Expected an automation run fixture')
        }
        const runs = [
          {
            ...fixtureRun,
            id: 'second',
            extension: {
              '3': 3,
              '1': 1,
              z: '雪 🐋\ud800',
              a: ['\\', '\n', '"', null],
              omitted: undefined
            }
          },
          { ...fixtureRun, id: 'first', extension: { fractional: -0 } }
        ]
        const settings = { note: 'unchanged' }
        const expected = JSON.stringify({ settings, automationRuns: runs })
        importProfileStateJson(db, JSON.stringify({ settings, automationRuns: runs.toReversed() }))
        if (operation === 'import') {
          importProfileStateJson(db, expected, { expectedRevision: 1 })
        } else {
          writeProfileStateDomains(db, {
            expectedRevision: 1,
            replacements:
              operation === 'replacement'
                ? [{ domain: 'automationRuns', payload: JSON.stringify(runs) }]
                : [],
            ...(operation === 'delta' ? { automationRunsAfter: runs } : {})
          })
        }

        expect(readProfileStateSnapshot(db)).toMatchObject({ revision: 2, json: expected })
        expect(
          writeProfileStateDomains(db, {
            expectedRevision: 2,
            replacements: [],
            automationRunsAfter: runs
          })
        ).toEqual({ changed: false, revision: 2, changedDomains: [] })
      } finally {
        db.close()
        rmSync(directory, { recursive: true, force: true })
      }
    }
  )
})
