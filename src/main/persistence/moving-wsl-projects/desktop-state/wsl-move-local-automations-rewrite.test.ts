import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WslMoveCutover } from '../../../../shared/wsl-move/wsl-move-cutover'
import { wslMoveCutoverFixture } from '../../__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { seedWslMoveCutover } from '../../__fixtures__/wsl-mover/wsl-move-journal-seeding'
import {
  stopWslMoveHostAutomations,
  type WslMoveHostAutomationPorts
} from '../cutover-recovery/wsl-move-undo-host-automations'
import {
  listWslMoveDesktopRewriteStores,
  resetWslMoveDesktopRewriteStoresForTests,
  type WslMoveDesktopRewriteContext
} from './wsl-move-desktop-rewrite-stores'
import {
  disableLocalAutomationsOfEarlierWslMoves,
  registerWslMoveLocalAutomationsStore
} from './wsl-move-local-automations-rewrite'

let userDataPath: string
beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'wsl-move-local-automations-'))
})
afterEach(() => {
  resetWslMoveDesktopRewriteStoresForTests()
  rmSync(userDataPath, { recursive: true, force: true })
})

const profile = () => ({
  disableAutomations: vi.fn(() => 1),
  flushPendingOrThrowAsync: async () => {}
})

function seed(phase: WslMoveCutover['phase'], rewrittenStores: string[] = []): void {
  seedWslMoveCutover(
    userDataPath,
    wslMoveCutoverFixture('move-1', phase, {
      automationsToReenable: ['auto-1', 'auto-2'],
      rewrittenStores
    })
  )
}

/** Undo with both copies here off, as the move left them; returns their states after. */
async function undoHere(hostStates: Record<string, boolean>) {
  const here = new Map([
    ['auto-1', false],
    ['auto-2', false]
  ])
  const advanced: string[] = []
  const ports: WslMoveHostAutomationPorts = {
    read: async () => hostStates,
    disable: async () => [],
    restore: async () => {},
    listHere: () => [...here].map(([id, enabled]) => ({ id, enabled })),
    setHere: (id, enabled) => here.set(id, enabled),
    advanceHere: (id) => advanced.push(id)
  }
  const stop = await stopWslMoveHostAutomations(userDataPath, 'move-1', [...here.keys()], ports)
  if (stop.outcome !== 'stopped') {
    throw new Error(`expected stopped, got ${stop.outcome}`)
  }
  stop.applyHere()
  return { here: Object.fromEntries(here), advanced }
}

describe('the local copies of moved automations', () => {
  it('turn off after commit, so only the host copy reads as live', async () => {
    seed('destination-committed')
    const local = profile()
    registerWslMoveLocalAutomationsStore(local, userDataPath)
    const store = listWslMoveDesktopRewriteStores()[0]
    if (store?.side !== 'main') {
      throw new Error('expected a main-side store')
    }
    const cutover = wslMoveCutoverFixture('move-1', 'destination-committed')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the store reads only the cutover.
    await store.run({ cutover } as unknown as WslMoveDesktopRewriteContext)
    expect(local.disableAutomations).toHaveBeenCalledWith(new Set(['auto-1', 'auto-2']))
  })

  it('turn off at startup for a move that finished before this step existed', async () => {
    seed('client-rewritten')
    const local = profile()
    await disableLocalAutomationsOfEarlierWslMoves(userDataPath, local)
    expect(local.disableAutomations).toHaveBeenCalledWith(new Set(['auto-1', 'auto-2']))
    // Once only: a copy the user turned back on after the catch-up stays on next launch.
    await disableLocalAutomationsOfEarlierWslMoves(userDataPath, local)
    expect(local.disableAutomations).toHaveBeenCalledTimes(1)
  })

  it('turn off at startup for every earlier move, past one that fails', async () => {
    seed('client-rewritten')
    seedWslMoveCutover(
      userDataPath,
      wslMoveCutoverFixture(
        'move-2',
        'client-rewritten',
        { automationsToReenable: ['auto-3'] },
        { repoIds: ['repo-2'] },
        undefined,
        'Debian'
      )
    )
    const local = profile()
    local.disableAutomations.mockImplementationOnce(() => {
      throw new Error('profile write failed')
    })
    await expect(disableLocalAutomationsOfEarlierWslMoves(userDataPath, local)).resolves.toBe(
      undefined
    )
    expect(local.disableAutomations).toHaveBeenCalledTimes(2)
  })

  it('come back on at undo when the host no longer has them, with a fresh next run', async () => {
    seed('client-rewritten')
    // The host read leaves out one deleted there; the user paused auto-2 on the host.
    const { here, advanced } = await undoHere({ 'auto-2': false })
    expect(here).toEqual({ 'auto-1': true, 'auto-2': false })
    expect(advanced).toEqual(['auto-1'])
  })

  it('come back on at undo while the host never confirmed turning them on', async () => {
    // Its ledger has the local step but not the host's enable.
    seed('destination-committed', ['local-automations'])
    const { here } = await undoHere({ 'auto-1': false, 'auto-2': false })
    expect(here).toEqual({ 'auto-1': true, 'auto-2': true })
  })
})
