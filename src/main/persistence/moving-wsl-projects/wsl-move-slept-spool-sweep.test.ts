import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { wslMoveCutoverFixture } from '../__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { seedWslMoveCutover } from '../__fixtures__/wsl-mover/wsl-move-journal-seeding'
import { wslMoveSleptSpoolRoot } from './wsl-move-slept-scrollback'
import { sweepOrphanedWslMoveSleptSpools } from './wsl-move-slept-spool-sweep'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function spool(userDataPath: string, migrationId: string): string {
  const dir = wslMoveSleptSpoolRoot(userDataPath, migrationId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '0.json'), '{}')
  return dir
}

describe('WSL move slept spool sweep', () => {
  // A kill at `quiesced` left its 25 KB document behind after the rollback.
  it("removes the spools of moves the journal no longer holds and keeps a live move's", () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'wsl-move-spool-sweep-'))
    roots.push(userDataPath)
    seedWslMoveCutover(userDataPath, wslMoveCutoverFixture('move-live', 'quiesced'))
    const live = spool(userDataPath, 'move-live')
    const orphan = spool(userDataPath, 'move-reset')

    sweepOrphanedWslMoveSleptSpools(userDataPath)

    expect(existsSync(live)).toBe(true)
    expect(existsSync(orphan)).toBe(false)
  })

  it('does nothing without a spool folder', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'wsl-move-spool-sweep-'))
    roots.push(userDataPath)
    expect(() => sweepOrphanedWslMoveSleptSpools(userDataPath)).not.toThrow()
  })
})
