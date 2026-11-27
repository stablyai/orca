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
import { listWslMoveCutovers } from '../cutover-recovery/wsl-move-cutover-journal'
import { advanceAutomationNextRuns } from '../../scheduling-automations/automation-schedule-operations'
import type { PersistedState } from '../../../../shared/orca-profiles/persisted-state-types'
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
async function undoHere(
  hostStates: Record<string, boolean | 'deleted'>,
  flushHere: () => Promise<void> = async () => {}
) {
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
    setHere: (updates) => {
      for (const { id, enabled } of updates) {
        here.set(id, enabled)
      }
      return { applied: [...updates] }
    },
    advanceHere: (ids) => advanced.push(...ids),
    flushHere
  }
  const stop = await stopWslMoveHostAutomations(userDataPath, 'move-1', [...here.keys()], ports)
  if (stop.outcome !== 'stopped') {
    throw new Error(`expected stopped, got ${stop.outcome}`)
  }
  await stop.applyHere()
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

  it('skips earlier moves with no moved automations without touching profile or journal', async () => {
    seedWslMoveCutover(
      userDataPath,
      wslMoveCutoverFixture('move-empty', 'client-rewritten', {
        automationsToReenable: []
      })
    )
    const local = {
      disableAutomations: vi.fn(() => 0),
      flushPendingOrThrowAsync: vi.fn(async () => {})
    }
    await disableLocalAutomationsOfEarlierWslMoves(userDataPath, local)
    expect(local.disableAutomations).not.toHaveBeenCalled()
    expect(local.flushPendingOrThrowAsync).not.toHaveBeenCalled()
  })

  it('come back on at undo with a fresh next run while paused or deleted ones stay off', async () => {
    seed('client-rewritten')
    // auto-1 stayed on on the host; auto-2 was deleted there.
    const { here, advanced } = await undoHere({ 'auto-1': true, 'auto-2': 'deleted' })
    expect(here).toEqual({ 'auto-1': true, 'auto-2': false })
    expect(advanced).toEqual(['auto-1'])
  })

  it('stay off at undo when deleted on the host after an earlier refused undo left them off', async () => {
    seedWslMoveCutover(
      userDataPath,
      wslMoveCutoverFixture('move-1', 'client-rewritten', {
        automationsToReenable: ['auto-1', 'auto-2'],
        hostAutomationsLeftOff: ['auto-1', 'auto-2'],
        undoHostAutomationIntent: { 'auto-1': true, 'auto-2': true }
      })
    )
    const { here, advanced } = await undoHere({ 'auto-1': false, 'auto-2': 'deleted' })
    // auto-1 is off on the host only because the refused undo left it off, so it comes back on.
    expect(here).toEqual({ 'auto-1': true, 'auto-2': false })
    expect(advanced).toEqual(['auto-1'])
    const cutover = listWslMoveCutovers(userDataPath)[0]
    expect(cutover?.hostAutomationsLeftOff).toEqual(['auto-1'])
    expect(cutover?.undoHostAutomationIntent).toEqual({ 'auto-1': true, 'auto-2': false })
  })

  it('reverts local writes and rejects when flushing local automations fails before release', async () => {
    seed('client-rewritten')
    const here = new Map([
      ['auto-1', false],
      ['auto-2', false]
    ])
    let flushes = 0
    const ports: WslMoveHostAutomationPorts = {
      read: async () => ({ 'auto-1': true, 'auto-2': false }),
      disable: async () => ['auto-1'],
      restore: async () => {},
      listHere: () => [...here].map(([id, enabled]) => ({ id, enabled })),
      setHere: (updates) => {
        for (const { id, enabled } of updates) {
          here.set(id, enabled)
        }
        return { applied: [...updates] }
      },
      advanceHere: () => {},
      flushHere: async () => {
        flushes += 1
        if (flushes === 1) {
          throw new Error('disk full')
        }
      }
    }
    const stop = await stopWslMoveHostAutomations(userDataPath, 'move-1', [...here.keys()], ports)
    if (stop.outcome !== 'stopped') {
      throw new Error(`expected stopped, got ${stop.outcome}`)
    }
    await expect(stop.applyHere()).rejects.toThrow('disk full')
    expect(Object.fromEntries(here)).toEqual({ 'auto-1': false, 'auto-2': false })
  })

  it('come back on at undo while the host never confirmed turning them on', async () => {
    // Its ledger has the local step but not the host's enable.
    seed('destination-committed', ['local-automations'])
    const { here } = await undoHere({ 'auto-1': false, 'auto-2': false })
    expect(here).toEqual({ 'auto-1': true, 'auto-2': true })
  })

  it('advances multiple recurring schedules in one flush while skipping one-shot waits', () => {
    const now = Date.UTC(2026, 5, 1, 12, 0, 0)
    const raw = {
      automations: [
        {
          id: 'sched-1',
          rrule: 'FREQ=HOURLY;INTERVAL=1',
          dtstart: Date.UTC(2026, 0, 1, 0, 0, 0),
          timezone: 'UTC',
          nextRunAt: now - 60_000,
          updatedAt: 0
        },
        {
          id: 'sched-2',
          rrule: 'FREQ=DAILY;INTERVAL=1',
          dtstart: Date.UTC(2026, 0, 1, 0, 0, 0),
          timezone: 'UTC',
          nextRunAt: now - 60_000,
          updatedAt: 0
        },
        {
          id: 'wait-1',
          once: true,
          rrule: 'FREQ=HOURLY;INTERVAL=1',
          dtstart: Date.UTC(2026, 0, 1, 0, 0, 0),
          timezone: 'UTC',
          nextRunAt: now - 60_000,
          updatedAt: 0
        }
      ]
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: advanceAutomationNextRuns reads only id, once, rrule, dtstart, timezone, and timezoneExplicit.
    const state = raw as unknown as PersistedState
    const flush = vi.fn()
    const advanced = advanceAutomationNextRuns(
      state,
      flush,
      new Set(['sched-1', 'sched-2', 'wait-1']),
      'desktop',
      now
    )
    expect(advanced).toBe(2)
    expect(flush).toHaveBeenCalledTimes(1)
    expect(state.automations[0].nextRunAt).toBeGreaterThan(now)
    expect(state.automations[1].nextRunAt).toBeGreaterThan(now)
    expect(state.automations[2].nextRunAt).toBe(now - 60_000)
  })
})
