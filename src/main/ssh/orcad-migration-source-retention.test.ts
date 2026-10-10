import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  listOrcadMigrationSourceCutovers,
  writeOrcadMigrationSourceCutover
} from './orcad-migration-cutover-journal'
import { orcadMigrationCutoverFixture } from './orcad-migration-cutover-fixture'
import { listPendingManagedOrcadMigrations } from './orcad-managed-migration-status'
import { retainOrcadMigrationSource } from './orcad-migration-source-retention'

let userDataPath: string

beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'orcad-retention-'))
})

afterEach(() => {
  rmSync(userDataPath, { recursive: true, force: true })
})

describe('retaining a committed migration source', () => {
  it('marks only a committed cutover, idempotently, and stops counting it as pending', () => {
    writeOrcadMigrationSourceCutover(userDataPath, orcadMigrationCutoverFixture('m-1'))
    expect(() => retainOrcadMigrationSource(userDataPath, 'm-1')).toThrow(
      'orcad_migration_retain_before_commit'
    )
    const committed = {
      ...orcadMigrationCutoverFixture('m-1'),
      phase: 'destination-committed' as const
    }
    writeOrcadMigrationSourceCutover(userDataPath, committed)
    const at = () => new Date('2026-10-03T00:00:00.000Z')
    retainOrcadMigrationSource(userDataPath, 'm-1', at)
    retainOrcadMigrationSource(userDataPath, 'm-1', () => new Date('2026-12-01T00:00:00.000Z'))
    expect(listOrcadMigrationSourceCutovers(userDataPath)[0]?.sourceRetainedAt).toBe(
      '2026-10-03T00:00:00.000Z'
    )
    expect(listPendingManagedOrcadMigrations(userDataPath)).toEqual([])
  })

  it('does not count retained cutovers against the in-flight journal capacity', () => {
    for (let index = 0; index < 4; index += 1) {
      const id = `m-${index}`
      writeOrcadMigrationSourceCutover(userDataPath, {
        ...orcadMigrationCutoverFixture(id, `ssh-${index}`),
        phase: 'destination-committed',
        sourceRetainedAt: '2026-10-03T00:00:00.000Z'
      })
    }
    expect(() =>
      writeOrcadMigrationSourceCutover(userDataPath, orcadMigrationCutoverFixture('m-new', 'ssh-9'))
    ).not.toThrow()
  })
})
