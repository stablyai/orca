import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeSecureJsonFileWithinLimit } from '../../shared/bounded-secure-json-file'
import { parseOrcadMigrationSourceCutover } from '../../shared/orcad-migration/orcad-migration-source-cutover'
import { orcadMigrationCutoverFixture as cutover } from './orcad-migration-cutover-fixture'
import {
  findOrcadMigrationSourceCutoverForTarget,
  listOrcadMigrationSourceCutovers,
  orcadMigrationCutoverJournalDirectory,
  removeOrcadMigrationSourceCutover,
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
  it('round-trips a cutover in an owner-only file', () => {
    writeOrcadMigrationSourceCutover(userDataPath, cutover())
    expect(findOrcadMigrationSourceCutoverForTarget(userDataPath, 'ssh-1')).toEqual(cutover())
    if (process.platform !== 'win32') {
      expect(statSync(journalPath('migration-1')).mode & 0o077).toBe(0)
    }
    removeOrcadMigrationSourceCutover(userDataPath, 'migration-1')
    expect(listOrcadMigrationSourceCutovers(userDataPath)).toEqual([])
  })

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

  it("reads a newer build's journal that adds an optional field", () => {
    mkdirSync(orcadMigrationCutoverJournalDirectory(userDataPath), { recursive: true })
    writeFileSync(journalPath('migration-1'), JSON.stringify({ ...cutover(), addedLater: true }))
    expect(listOrcadMigrationSourceCutovers(userDataPath)).toEqual([cutover()])
  })

  it('serves repeat reads from cache yet sees a file rewritten behind its back', () => {
    writeOrcadMigrationSourceCutover(userDataPath, cutover())
    const first = listOrcadMigrationSourceCutovers(userDataPath)
    expect(listOrcadMigrationSourceCutovers(userDataPath)[0]).toBe(first[0])
    writeFileSync(
      journalPath('migration-1'),
      JSON.stringify({ ...cutover(), phase: 'destination-staged' })
    )
    expect(listOrcadMigrationSourceCutovers(userDataPath)[0]?.phase).toBe('destination-staged')
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

  it('bounds concurrent migrations but rewrites an existing one', () => {
    for (const index of [1, 2, 3, 4]) {
      writeOrcadMigrationSourceCutover(userDataPath, cutover(`m-${index}`, `ssh-${index}`))
    }
    expect(() => writeOrcadMigrationSourceCutover(userDataPath, cutover('m-5', 'ssh-5'))).toThrow(
      'capacity'
    )
    writeOrcadMigrationSourceCutover(userDataPath, {
      ...cutover('m-1', 'ssh-1'),
      phase: 'destination-staged'
    })
    expect(findOrcadMigrationSourceCutoverForTarget(userDataPath, 'ssh-1')?.phase).toBe(
      'destination-staged'
    )
  })

  // Older desktops read these files: the shared store must keep the path and bytes the SSH
  // journal has always written (the exact call it made before the store existed).
  it('writes the same path and bytes the SSH journal always wrote', () => {
    writeOrcadMigrationSourceCutover(userDataPath, cutover())
    expect(orcadMigrationCutoverJournalDirectory(userDataPath)).toBe(
      join(userDataPath, 'orcad-migration-cutovers')
    )
    const reference = join(userDataPath, 'reference.json')
    writeSecureJsonFileWithinLimit(
      reference,
      parseOrcadMigrationSourceCutover(cutover()),
      16 * 1024 * 1024,
      { durable: true }
    )
    expect(readFileSync(journalPath('migration-1'))).toEqual(readFileSync(reference))
  })
})
