import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WSL_HOSTS_INTERNAL_GATE_ENV } from '../../../shared/wsl-host-internal-gate'
import {
  createWslMoveWorld,
  type WslMoveWorld
} from '../__fixtures__/wsl-mover/wsl-move-driver-world'
import { wslMoveCutoverFixture } from '../__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { seedWslMoveCutover } from '../__fixtures__/wsl-mover/wsl-move-journal-seeding'
import { listWslMoveCutovers } from './wsl-move-cutover-journal'
import {
  registerWslMoveDesktopRewriteStore,
  resetWslMoveDesktopRewriteStoresForTests,
  setWslMoveDesktopRewriteRegistryCompleteForTests
} from './wsl-move-desktop-rewrite-stores'
import { moveProjectsToWslHost, previewWslMove } from './wsl-move-driver'
import { claimWslMoveRun, isWslMoveRunning, releaseWslMoveRun } from './wsl-move-running-moves'
import { runWslMoveDesktopRewritePass } from './wsl-move-desktop-rewrite'
import {
  isWslMoveWindowWriteHeld,
  resetWslMoveWindowWriteHoldForTests,
  setWslMoveReloadableWindow
} from './wsl-move-window-write-hold'

let userDataPath: string
let world: WslMoveWorld

beforeEach(() => {
  vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '1')
  userDataPath = mkdtempSync(join(tmpdir(), 'wsl-move-preview-settle-'))
  world = createWslMoveWorld(userDataPath)
  setWslMoveDesktopRewriteRegistryCompleteForTests(true)
  registerWslMoveDesktopRewriteStore({
    id: 'ui-routing',
    side: 'main',
    run: () => {},
    flush: () => {}
  })
})

afterEach(() => {
  vi.unstubAllEnvs()
  resetWslMoveDesktopRewriteStoresForTests()
  resetWslMoveWindowWriteHoldForTests()
  rmSync(userDataPath, { recursive: true, force: true })
})

const request = { distro: 'Ubuntu' }
const journal = () => listWslMoveCutovers(userDataPath)
const AUTOMATIC = { settleInterrupted: 'finish-at-restart' } as const

// An app update or crash between sending the copy and the host's commit leaves this record; the
// startup recovery has no host to ask, so the projects stay fenced until a move settles it.
function seedInterruptedCommit(): string {
  const stuck = wslMoveCutoverFixture('stuck', 'blobs-transferred', {}, { repoIds: ['repo-9'] })
  seedWslMoveCutover(userDataPath, stuck)
  return stuck.migrationId
}

describe('the automatic mover previewing after an interrupted commit', () => {
  it('a read-only preview leaves the record and stays refused, as the dialog needs', async () => {
    seedInterruptedCommit()
    expect(await previewWslMove(world.deps, request)).toEqual({
      outcome: 'refused',
      code: 'wsl_move_already_in_flight'
    })
    expect(journal().map((cutover) => cutover.phase)).toEqual(['blobs-transferred'])
  })

  it('resets a commit the host never made, lifting the fence, and previews the move', async () => {
    world.catalog.set(seedInterruptedCommit(), 'staged')
    expect(await previewWslMove(world.deps, request, AUTOMATIC)).toMatchObject({
      outcome: 'ready',
      distro: 'Ubuntu'
    })
    expect(journal().map((cutover) => cutover.migrationId)).not.toContain('stuck')
    expect(world.catalog.has('stuck')).toBe(false)
    expect(isWslMoveRunning('Ubuntu')).toBe(false)
  })

  it('records a commit the host made, but leaves the window and its reload to the next start', async () => {
    const window = {
      isDestroyed: () => false,
      reload: vi.fn(),
      allowUnload: vi.fn(() => () => {}),
      onLoadedOrGone: vi.fn(() => () => {})
    }
    setWslMoveReloadableWindow(() => window)
    world.catalog.set(seedInterruptedCommit(), 'committed')
    expect(await previewWslMove(world.deps, request, AUTOMATIC)).toEqual({
      outcome: 'refused',
      code: 'wsl_move_finished_earlier_move',
      detail: 'finish-pending'
    })
    expect(journal().find((cutover) => cutover.migrationId === 'stuck')?.phase).toBe(
      'destination-committed'
    )
    // An automatic step never reloads the window past its unload veto, nor drops its saves.
    await new Promise((resolve) => setImmediate(resolve))
    expect(window.allowUnload).not.toHaveBeenCalled()
    expect(window.reload).not.toHaveBeenCalled()
    expect(isWslMoveWindowWriteHeld()).toBe(false)
    // The next start's pass, before any window opens, finishes it forward.
    setWslMoveReloadableWindow(() => null)
    await runWslMoveDesktopRewritePass({ userDataPath, warn: () => {} })
    expect(journal().find((cutover) => cutover.migrationId === 'stuck')?.phase).toBe(
      'client-rewritten'
    )
  })

  it("lets the user's Move finish a commit the automatic settle left for a restart", async () => {
    world.catalog.set(seedInterruptedCommit(), 'committed')
    await previewWslMove(world.deps, request, AUTOMATIC)
    const finishOnDesktop = vi.spyOn(world.deps, 'finishOnDesktop')

    expect(await moveProjectsToWslHost(world.deps, request)).toEqual({
      outcome: 'refused',
      code: 'wsl_move_finished_earlier_move'
    })
    expect(finishOnDesktop).toHaveBeenCalledTimes(1)
    expect(journal().find((cutover) => cutover.migrationId === 'stuck')?.phase).toBe(
      'client-rewritten'
    )
    // Nothing of a new move started under the window that must reload first.
    expect(world.slept).toEqual([])
  })

  it('leaves settling to a move this process is already running', async () => {
    seedInterruptedCommit()
    const running = claimWslMoveRun('Ubuntu')
    try {
      expect(await previewWslMove(world.deps, request, AUTOMATIC)).toEqual({
        outcome: 'refused',
        code: 'wsl_move_already_running'
      })
      expect(journal().map((cutover) => cutover.phase)).toEqual(['blobs-transferred'])
    } finally {
      if (running) {
        releaseWslMoveRun('Ubuntu', running)
      }
    }
  })
})
