import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { orcadMigrationCutoverFixture as cutover } from '../../../managed-server/migration/cutover/testing/orcad-migration-cutover-fixture'
import {
  findOrcadMigrationSourceCutoverForTarget,
  listOrcadMigrationSourceCutovers,
  orcadMigrationCutoverJournalDirectory,
  writeOrcadMigrationSourceCutover
} from './orcad-migration-cutover-journal'

let userDataPath: string
beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'orcad-cutover-journal-'))
})
afterEach(() => rmSync(userDataPath, { recursive: true, force: true }))

const journalPath = (id: string) =>
  join(orcadMigrationCutoverJournalDirectory(userDataPath), `${id}.json`)

describe('migration cutover journal sidecar', () => {
  it.each([
    ['corrupt JSON', '{not json'],
    ['a manifest bound to another target', JSON.stringify({ ...cutover(), sshTargetId: 'ssh-2' })],
    ['a tampered manifest', JSON.stringify({ ...cutover(), manifestSha256: 'f'.repeat(64) })],
    ['an unknown version', JSON.stringify({ ...cutover(), version: 2 })]
  ])('fails closed on %s', (_label, contents) => {
    mkdirSync(orcadMigrationCutoverJournalDirectory(userDataPath), { recursive: true })
    writeFileSync(journalPath('migration-1'), contents)
    expect(() => listOrcadMigrationSourceCutovers(userDataPath)).toThrow('stays fenced')
  })

  it('fails closed on a file whose name disagrees with its migration', () => {
    mkdirSync(orcadMigrationCutoverJournalDirectory(userDataPath), { recursive: true })
    writeFileSync(journalPath('other'), JSON.stringify(cutover()))
    expect(() => listOrcadMigrationSourceCutovers(userDataPath)).toThrow('stays fenced')
  })

  it('ignores durable-write temporaries but refuses two journals for one target', () => {
    writeOrcadMigrationSourceCutover(userDataPath, cutover())
    writeFileSync(join(orcadMigrationCutoverJournalDirectory(userDataPath), 'x.json.tmp'), '?')
    expect(listOrcadMigrationSourceCutovers(userDataPath)).toHaveLength(1)
    writeOrcadMigrationSourceCutover(userDataPath, cutover('migration-2'))
    expect(() => findOrcadMigrationSourceCutoverForTarget(userDataPath, 'ssh-1')).toThrow(
      'journals name SSH target'
    )
  })
})
