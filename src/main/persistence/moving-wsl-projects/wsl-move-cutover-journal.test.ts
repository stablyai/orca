import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { wslMoveCutoverFixture as cutover } from '../__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { seedWslMoveCutover } from '../__fixtures__/wsl-mover/wsl-move-journal-seeding'
import {
  listWslMoveCutoverChain,
  listWslMoveCutovers,
  removeWslMoveCutover,
  writeWslMoveCutover,
  wslMoveJournalDirectory
} from './wsl-move-cutover-journal'
import { resetWslMoveDesktopRewriteStoresForTests } from './wsl-move-desktop-rewrite-stores'

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
  it('refuses a second move into a distro while the first is in flight', () => {
    seedWslMoveCutover(userDataPath, cutover('move-1', 'quiesced'))
    expect(() =>
      writeWslMoveCutover(
        userDataPath,
        cutover('move-2', 'prepared', { supersedesMigrationId: 'move-1' })
      )
    ).toThrow('wsl_move_already_in_flight')
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

  it('refuses to remove a move a later move of its distro supersedes, so the chain stays readable', () => {
    seedWslMoveCutover(userDataPath, cutover('move-1', 'retained'))
    seedWslMoveCutover(
      userDataPath,
      cutover('move-2', 'retained', { supersedesMigrationId: 'move-1' }, { repoIds: ['repo-2'] })
    )
    seedWslMoveCutover(
      userDataPath,
      cutover('move-3', 'retained', { supersedesMigrationId: 'move-2' }, { repoIds: ['repo-3'] })
    )

    expect(() => removeWslMoveCutover(userDataPath, 'move-2')).toThrow('wsl_move_superseded')
    expect(() => removeWslMoveCutover(userDataPath, 'move-1')).toThrow('wsl_move_superseded')
    expect(
      listWslMoveCutoverChain(userDataPath, 'local-wsl:ubuntu').map((c) => c.migrationId)
    ).toEqual(['move-1', 'move-2', 'move-3'])
    // Newest first, one at a time, and the chain reads after every step.
    removeWslMoveCutover(userDataPath, 'move-3')
    expect(listWslMoveCutoverChain(userDataPath, 'local-wsl:ubuntu')).toHaveLength(2)
    removeWslMoveCutover(userDataPath, 'move-2')
    removeWslMoveCutover(userDataPath, 'move-1')
    expect(listWslMoveCutovers(userDataPath)).toEqual([])
  })
})
