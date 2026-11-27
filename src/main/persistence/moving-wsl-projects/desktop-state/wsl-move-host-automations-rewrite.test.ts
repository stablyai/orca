import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { wslMoveCutoverFixture } from '../../__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { seedWslMoveCutover } from '../../__fixtures__/wsl-mover/wsl-move-journal-seeding'
import {
  listWslMoveCutovers,
  removeCommittedWslMoveCutover
} from '../cutover-recovery/wsl-move-cutover-journal'
import {
  runWslMoveHostAutomationsExclusive,
  WSL_MOVE_HOST_AUTOMATION_TURN_DEADLINE_MS
} from '../cutover-recovery/wsl-move-host-automations-lock'
import {
  listWslMoveDesktopRewriteStores,
  resetWslMoveDesktopRewriteStoresForTests,
  type WslMoveDesktopRewriteContext
} from './wsl-move-desktop-rewrite-stores'
import {
  registerWslMoveHostAutomationsStore,
  wslMoveAutomationsPending,
  type WslMoveMovedAutomation
} from './wsl-move-host-automations-rewrite'

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

  it('gives up its turn at the deadline on a hung host, failing so the pass retries it', async () => {
    vi.useFakeTimers()
    try {
      const cutover = wslMoveCutoverFixture('move-1', 'destination-committed', {
        automationsToReenable: ['auto-1']
      })
      seedWslMoveCutover(userDataPath, cutover)
      let seen: AbortSignal | undefined
      // Never answers, whatever the signal says.
      const enable = vi.fn((_env: string, _ids: unknown, signal?: AbortSignal) => {
        seen = signal
        return new Promise<void>(() => {})
      })
      registerWslMoveHostAutomationsStore({ enable }, userDataPath)
      const store = listWslMoveDesktopRewriteStores()[0]
      if (store?.side !== 'main') {
        throw new Error('expected a main-side store')
      }
      const pass = Promise.resolve(
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the store reads only the cutover.
        store.run({ cutover } as unknown as WslMoveDesktopRewriteContext)
      )
      const outcome = pass.then(
        () => 'finished',
        (error: Error) => error.message
      )
      const undo = runWslMoveHostAutomationsExclusive(async () => 'undo ran')
      await vi.advanceTimersByTimeAsync(WSL_MOVE_HOST_AUTOMATION_TURN_DEADLINE_MS)
      await expect(outcome).resolves.toBe('wsl_move_host_automation_turn_timed_out')
      expect(seen?.aborted).toBe(true)
      await expect(undo).resolves.toBe('undo ran')
    } finally {
      vi.useRealTimers()
    }
  })

  it('persists confirmed ids on timeout so the next pass resumes with only the remainder', async () => {
    vi.useFakeTimers()
    try {
      const cutover = wslMoveCutoverFixture('move-1', 'destination-committed', {
        automationsToReenable: ['auto-1', 'auto-2', 'auto-3']
      })
      seedWslMoveCutover(userDataPath, cutover)
      const seenBatches: string[][] = []
      let lateSettle: (() => void) | undefined
      const enable = vi.fn(
        (
          _env: string,
          automations: readonly WslMoveMovedAutomation[],
          _signal?: AbortSignal,
          onSettled?: (id: string) => void
        ) => {
          seenBatches.push(automations.map((row) => row.id))
          if (seenBatches.length === 1) {
            onSettled?.('auto-1')
            onSettled?.('auto-2')
            lateSettle = () => onSettled?.('auto-3')
            return new Promise<void>(() => {})
          }
          for (const row of automations) {
            onSettled?.(row.id)
          }
          return Promise.resolve()
        }
      )
      registerWslMoveHostAutomationsStore({ enable }, userDataPath)
      const store = listWslMoveDesktopRewriteStores()[0]
      if (store?.side !== 'main') {
        throw new Error('expected a main-side store')
      }

      const firstPass = Promise.resolve(
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the store reads only the cutover.
        store.run({ cutover } as unknown as WslMoveDesktopRewriteContext)
      ).then(
        () => 'finished',
        (error: Error) => error.message
      )
      await vi.advanceTimersByTimeAsync(WSL_MOVE_HOST_AUTOMATION_TURN_DEADLINE_MS)
      await expect(firstPass).resolves.toBe('wsl_move_host_automation_turn_timed_out')
      // A late callback from the abandoned turn must not mark the timed-out id confirmed.
      lateSettle?.()

      const persisted = listWslMoveCutovers(userDataPath)[0]
      expect(persisted?.reenabledAutomationIds).toEqual(['auto-1', 'auto-2'])
      expect(persisted ? wslMoveAutomationsPending(persisted) : []).toEqual(['auto-3'])

      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the store reads only the cutover.
      await store.run({ cutover } as unknown as WslMoveDesktopRewriteContext)
      expect(seenBatches).toEqual([['auto-1', 'auto-2', 'auto-3'], ['auto-3']])
    } finally {
      vi.useRealTimers()
    }
  })
})
