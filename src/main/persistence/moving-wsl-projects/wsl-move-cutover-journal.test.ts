import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  WSL_MOVE_CUTOVER_PHASES,
  wslMoveJournalKey
} from '../../../shared/wsl-move/wsl-move-cutover'
import { wslMoveCutoverFixture as cutover } from '../__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { seedWslMoveCutover } from '../__fixtures__/wsl-mover/wsl-move-journal-seeding'
import { computeOrcadMigrationManifestSha256 } from '../../orcad/orcad-migration-manifest-digest'
import { orcadMigrationCutoverJournalDirectory } from '../../ssh/orcad-migration-cutover-journal'
import {
  listWslMoveCutoverChain,
  listWslMoveCutovers,
  removeWslMoveCutover,
  writeWslMoveCutover,
  wslMoveJournalDirectory
} from './wsl-move-cutover-journal'
import {
  resetWslMoveDesktopRewriteStoresForTests,
  setWslMoveDesktopRewriteRegistryCompleteForTests
} from './wsl-move-desktop-rewrite-stores'

let userDataPath: string
beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'wsl-move-journal-'))
})
afterEach(() => {
  resetWslMoveDesktopRewriteStoresForTests()
  rmSync(userDataPath, { recursive: true, force: true })
})

const journalPath = (id: string) => join(wslMoveJournalDirectory(userDataPath), `${id}.json`)

describe('WSL move journal', () => {
  it('round-trips a move in an owner-only file of its own directory', () => {
    writeWslMoveCutover(userDataPath, cutover())
    expect(listWslMoveCutovers(userDataPath)).toEqual([cutover()])
    expect(wslMoveJournalDirectory(userDataPath)).not.toBe(
      orcadMigrationCutoverJournalDirectory(userDataPath)
    )
    if (process.platform !== 'win32') {
      expect(statSync(journalPath('move-1')).mode & 0o077).toBe(0)
    }
    removeWslMoveCutover(userDataPath, 'move-1')
    expect(listWslMoveCutovers(userDataPath)).toEqual([])
  })

  it.each([
    ['corrupt JSON', '{not json'],
    ['another distro key', JSON.stringify({ ...cutover(), journalKey: 'local-wsl:debian' })],
    ['a tampered manifest', JSON.stringify({ ...cutover(), manifestSha256: 'f'.repeat(64) })],
    ['an unknown phase', JSON.stringify({ ...cutover(), phase: 'teleported' })]
  ])('fails closed on %s', (_label, contents) => {
    mkdirSync(wslMoveJournalDirectory(userDataPath), { recursive: true })
    writeFileSync(journalPath('move-1'), contents)
    expect(() => listWslMoveCutovers(userDataPath)).toThrow('stay fenced')
  })

  it('refuses a second move into a distro while the first is in flight', () => {
    seedWslMoveCutover(userDataPath, cutover('move-1', 'quiesced'))
    expect(() =>
      writeWslMoveCutover(
        userDataPath,
        cutover('move-2', 'prepared', { supersedesMigrationId: 'move-1' })
      )
    ).toThrow('wsl_move_already_in_flight')
  })

  it('chains a delta move after a finished one, and only onto the head', () => {
    seedWslMoveCutover(userDataPath, cutover('move-1', 'retained'))
    expect(() => writeWslMoveCutover(userDataPath, cutover('move-2'))).toThrow(
      'wsl_move_must_extend_its_chain'
    )
    writeWslMoveCutover(
      userDataPath,
      cutover('move-2', 'prepared', { supersedesMigrationId: 'move-1' })
    )
    expect(
      listWslMoveCutoverChain(userDataPath, wslMoveJournalKey('ubuntu')).map((c) => c.migrationId)
    ).toEqual(['move-1', 'move-2'])
  })

  it('advances its own record through the phases', () => {
    writeWslMoveCutover(userDataPath, cutover('move-1', 'prepared'))
    writeWslMoveCutover(userDataPath, cutover('move-1', 'source-fenced'))
    expect(listWslMoveCutovers(userDataPath)[0]?.phase).toBe('source-fenced')
  })

  it('rejects phase regression and rebinding, and allows an unchanged finished link', () => {
    setWslMoveDesktopRewriteRegistryCompleteForTests(true)
    seedWslMoveCutover(userDataPath, cutover('move-1', 'destination-committed'))
    expect(() => writeWslMoveCutover(userDataPath, cutover('move-1', 'prepared'))).toThrow(
      'wsl_move_phase_regressed'
    )
    expect(() =>
      writeWslMoveCutover(
        userDataPath,
        cutover('move-1', 'retained', {}, { repoIds: ['repo-1', 'repo-2'] })
      )
    ).toThrow('wsl_move_binding_changed')
    writeWslMoveCutover(userDataPath, cutover('move-1', 'client-rewritten'))
    writeWslMoveCutover(userDataPath, cutover('move-1', 'retained'))
    writeWslMoveCutover(
      userDataPath,
      cutover('move-2', 'prepared', { supersedesMigrationId: 'move-1' })
    )
    writeWslMoveCutover(userDataPath, cutover('move-1', 'retained'))
  })

  it('hands out records a caller cannot edit into the next comparison', () => {
    seedWslMoveCutover(userDataPath, cutover('move-1', 'destination-committed'))
    const [listed] = listWslMoveCutovers(userDataPath)
    if (listed) {
      listed.phase = 'prepared'
    }
    expect(listWslMoveCutovers(userDataPath)[0]?.phase).toBe('destination-committed')
    expect(() => writeWslMoveCutover(userDataPath, cutover('move-1', 'prepared'))).toThrow(
      'wsl_move_phase_regressed'
    )
  })

  it('refuses one id for two distros, and a first move that names a predecessor', () => {
    expect(() =>
      writeWslMoveCutover(
        userDataPath,
        cutover('move-9', 'prepared', { supersedesMigrationId: 'gone' })
      )
    ).toThrow('wsl_move_must_extend_its_chain')
    writeWslMoveCutover(userDataPath, cutover('move-1'))
    const debian = cutover('move-1')
    const other = { ...debian, journalKey: wslMoveJournalKey('Debian') }
    other.manifest = { ...debian.manifest, source: { ...debian.manifest.source, distro: 'Debian' } }
    const { manifestSha256: _digest, ...unsigned } = other.manifest
    other.manifest.manifestSha256 = computeOrcadMigrationManifestSha256(unsigned)
    other.manifestSha256 = other.manifest.manifestSha256
    expect(() => writeWslMoveCutover(userDataPath, other)).toThrow('wsl_move_id_in_use')
  })

  it('refuses a later phase whose record is missing or was lifted, or that skips a phase', () => {
    expect(() => writeWslMoveCutover(userDataPath, cutover('move-1', 'source-fenced'))).toThrow(
      'wsl_move_record_missing'
    )
    seedWslMoveCutover(userDataPath, cutover('move-1', 'source-fenced'))
    removeWslMoveCutover(userDataPath, 'move-1')
    expect(() => writeWslMoveCutover(userDataPath, cutover('move-1', 'quiesced'))).toThrow(
      'wsl_move_record_missing'
    )
    expect(listWslMoveCutovers(userDataPath)).toEqual([])
    writeWslMoveCutover(userDataPath, cutover('move-1', 'prepared'))
    expect(() => writeWslMoveCutover(userDataPath, cutover('move-1', 'quiesced'))).toThrow(
      'wsl_move_phase_skipped'
    )
  })

  it.each(WSL_MOVE_CUTOVER_PHASES.slice(2, -1))('refuses to remove a %s record', (phase) => {
    seedWslMoveCutover(userDataPath, cutover('move-1', phase))
    expect(() => removeWslMoveCutover(userDataPath, 'move-1')).toThrow('wsl_move_in_flight')
    expect(listWslMoveCutovers(userDataPath)[0]?.phase).toBe(phase)
  })

  it('lifts a fence whose quiesce refused: nothing reached the destination yet', () => {
    seedWslMoveCutover(userDataPath, cutover('move-1', 'source-fenced'))
    removeWslMoveCutover(userDataPath, 'move-1')
    expect(listWslMoveCutovers(userDataPath)).toEqual([])
  })

  it('fails closed on a manifest edited without re-signing it', () => {
    const record = cutover()
    const edited = {
      ...record,
      manifest: {
        ...record.manifest,
        source: { ...record.manifest.source, scopeRepoIds: ['repo-2'] },
        payload: {
          ...record.manifest.payload,
          repositories: [{ ...record.manifest.payload.repositories[0], id: 'repo-2' }]
        }
      }
    }
    mkdirSync(wslMoveJournalDirectory(userDataPath), { recursive: true })
    writeFileSync(journalPath('move-1'), JSON.stringify(edited))
    expect(() => listWslMoveCutovers(userDataPath)).toThrow('stay fenced')
  })
})
