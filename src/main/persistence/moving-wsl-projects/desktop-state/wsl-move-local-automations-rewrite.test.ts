import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { wslMoveCutoverFixture } from '../../__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { seedWslMoveCutover } from '../../__fixtures__/wsl-mover/wsl-move-journal-seeding'
import { stopWslMoveHostAutomations } from '../cutover-recovery/wsl-move-undo-host-automations'
import {
  listWslMoveDesktopRewriteStores,
  resetWslMoveDesktopRewriteStoresForTests,
  type WslMoveDesktopRewriteContext
} from './wsl-move-desktop-rewrite-stores'
import { registerWslMoveLocalAutomationsStore } from './wsl-move-local-automations-rewrite'

let userDataPath: string
beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'wsl-move-local-automations-'))
})
afterEach(() => {
  resetWslMoveDesktopRewriteStoresForTests()
  rmSync(userDataPath, { recursive: true, force: true })
})

describe('the local copies of moved automations', () => {
  it('turn off after commit, so only the host copy reads as live', async () => {
    const disableAutomations = vi.fn(() => 1)
    registerWslMoveLocalAutomationsStore({
      disableAutomations,
      flushPendingOrThrowAsync: async () => {}
    })
    const store = listWslMoveDesktopRewriteStores()[0]
    if (store?.side !== 'main') {
      throw new Error('expected a main-side store')
    }
    const cutover = wslMoveCutoverFixture('move-1', 'destination-committed', {
      automationsToReenable: ['auto-1']
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the store reads only the cutover.
    await store.run({ cutover } as unknown as WslMoveDesktopRewriteContext)
    expect(disableAutomations).toHaveBeenCalledWith(new Set(['auto-1']))
  })

  it('come back on at undo when the host no longer answers for them', async () => {
    seedWslMoveCutover(
      userDataPath,
      wslMoveCutoverFixture('move-1', 'client-rewritten', {
        automationsToReenable: ['auto-1', 'auto-2']
      })
    )
    const here = new Map([
      ['auto-1', false],
      ['auto-2', false]
    ])
    const stop = await stopWslMoveHostAutomations(userDataPath, 'move-1', ['auto-1', 'auto-2'], {
      // The user paused auto-2 on the host; auto-1 is gone there.
      read: async () => ({ 'auto-2': false }),
      disable: async () => [],
      restore: async () => {},
      listHere: () => [...here].map(([id, enabled]) => ({ id, enabled })),
      setHere: (id, enabled) => here.set(id, enabled)
    })
    if (stop.outcome !== 'stopped') {
      throw new Error(`expected stopped, got ${stop.outcome}`)
    }
    stop.applyHere()
    expect(Object.fromEntries(here)).toEqual({ 'auto-1': true, 'auto-2': false })
  })
})
