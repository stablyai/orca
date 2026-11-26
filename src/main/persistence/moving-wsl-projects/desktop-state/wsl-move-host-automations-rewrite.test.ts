import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { wslMoveCutoverFixture } from '../../__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { seedWslMoveCutover } from '../../__fixtures__/wsl-mover/wsl-move-journal-seeding'
import { removeCommittedWslMoveCutover } from '../cutover-recovery/wsl-move-cutover-journal'
import { runWslMoveHostAutomationsExclusive } from '../cutover-recovery/wsl-move-host-automations-lock'
import {
  listWslMoveDesktopRewriteStores,
  resetWslMoveDesktopRewriteStoresForTests,
  type WslMoveDesktopRewriteContext
} from './wsl-move-desktop-rewrite-stores'
import { registerWslMoveHostAutomationsStore } from './wsl-move-host-automations-rewrite'

let userDataPath: string
beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'wsl-move-host-automations-'))
})
afterEach(() => {
  resetWslMoveDesktopRewriteStoresForTests()
  rmSync(userDataPath, { recursive: true, force: true })
})

describe('the host-automations rewrite step', () => {
  it('leaves the host copies off when an undo in progress releases the move', async () => {
    const cutover = wslMoveCutoverFixture('move-1', 'destination-committed', {
      automationsToReenable: ['auto-1']
    })
    seedWslMoveCutover(userDataPath, cutover)
    const enable = vi.fn(async () => {})
    registerWslMoveHostAutomationsStore({ enable }, userDataPath)
    const store = listWslMoveDesktopRewriteStores()[0]
    if (store?.side !== 'main') {
      throw new Error('expected a main-side store')
    }
    let finishUndo = (): void => {}
    const undoReleased = new Promise<void>((resolve) => {
      finishUndo = resolve
    })
    // An undo holds the turn, then releases the move.
    const undo = runWslMoveHostAutomationsExclusive(async () => {
      await undoReleased
      removeCommittedWslMoveCutover(userDataPath, 'move-1')
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the store reads only the cutover.
    const pass = store.run({ cutover } as unknown as WslMoveDesktopRewriteContext)
    finishUndo()
    await Promise.all([undo, pass])
    expect(enable).not.toHaveBeenCalled()
  })
})
