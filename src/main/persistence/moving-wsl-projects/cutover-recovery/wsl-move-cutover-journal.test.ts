import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { wslMoveCutoverFixture as cutover } from '../../__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { seedWslMoveCutover } from '../../__fixtures__/wsl-mover/wsl-move-journal-seeding'
import {
  listWslMoveCutovers,
  removeWslMoveCutover,
  writeWslMoveCutover,
  wslMoveJournalDirectory
} from './wsl-move-cutover-journal'
import { resetWslMoveDesktopRewriteStoresForTests } from '../desktop-state/wsl-move-desktop-rewrite-stores'

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
})
