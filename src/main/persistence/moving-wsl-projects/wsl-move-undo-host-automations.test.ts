import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { wslMoveCutoverFixture } from '../__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { seedWslMoveCutover } from '../__fixtures__/wsl-mover/wsl-move-journal-seeding'
import {
  listWslMoveCutovers,
  removeCommittedWslMoveCutover,
  writeWslMoveCutover
} from './wsl-move-cutover-journal'
import { listUnfinishedWslMoves } from './wsl-move-host-automations-rewrite'
import { resetWslMoveDesktopRewriteStoresForTests } from './wsl-move-desktop-rewrite-stores'
import {
  retryWslMoveHostAutomationsLeftOff,
  runWslMoveHostAutomationsExclusive,
  settleInterruptedWslMoveUndos,
  stopWslMoveHostAutomations,
  wslMoveLocalAutomationStateUpdates,
  wslMoveMovedAutomationIds,
  type WslMoveHostAutomationPorts
} from './wsl-move-undo-host-automations'

const MOVE = 'move-1'

/** A fake host and the copies here; `host` is each automation's enabled flag there. */
function world(hostStates: Record<string, boolean>, here: Record<string, boolean>) {
  const host = new Map(Object.entries(hostStates))
  const local = new Map(Object.entries(here))
  const fail: { disableAt: string | null; restore: boolean } = { disableAt: null, restore: false }
  const ports: WslMoveHostAutomationPorts = {
    read: async (ids) => Object.fromEntries(ids.map((id) => [id, host.get(id) ?? false])),
    disable: async (ids) => {
      const done: string[] = []
      for (const id of ids) {
        if (id === fail.disableAt) {
          // The host drops mid-loop: what was turned off stays off.
          throw Object.assign(new Error('wsl_move_automation_disable_failed:gone'), {
            leftOff: done
          })
        }
        host.set(id, false)
        done.push(id)
      }
      return done
    },
    restore: async (ids) => {
      if (fail.restore) {
        throw new Error('host gone')
      }
      for (const id of ids) {
        host.set(id, true)
      }
    },
    listHere: () => [...local].map(([id, enabled]) => ({ id, enabled })),
    setHere: (id, enabled) => {
      local.set(id, enabled)
    }
  }
  return { host, local, fail, ports }
}

describe("undo's host automation step", () => {
  it("reads every one of this move's automations, and only this move's", () => {
    const moveOf = (...ids: string[]) => ({
      manifest: { payload: { dormantState: { automations: ids.map((id) => ({ id })) } } }
    })
    expect(wslMoveMovedAutomationIds(moveOf('a', 'b'))).toEqual(['a', 'b'])
    expect(wslMoveMovedAutomationIds({ manifest: { payload: {} } })).toEqual([])
  })

  it('writes only the copies here that differ from the choice', () => {
    expect(
      wslMoveLocalAutomationStateUpdates(
        [
          { id: 'a', enabled: true },
          { id: 'b', enabled: false },
          { id: 'c', enabled: true },
          { id: 'not-moved', enabled: true }
        ],
        { a: false, b: true, c: true }
      )
    ).toEqual([
      { id: 'a', enabled: false },
      { id: 'b', enabled: true }
    ])
  })
})

describe('undo of a move with automations', () => {
  let userDataPath: string
  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'wsl-move-undo-automations-'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    seedWslMoveCutover(userDataPath, wslMoveCutoverFixture(MOVE, 'retained'))
  })
  afterEach(() => {
    vi.restoreAllMocks()
    resetWslMoveDesktopRewriteStoresForTests()
    rmSync(userDataPath, { recursive: true, force: true })
  })
  const cutover = () => listWslMoveCutovers(userDataPath)[0]

  // d3a: undo kept the pre-move state and dropped what the user chose on the host since.
  it("turns off every host copy that is on, and gives the copies here the host's state", async () => {
    // off-on-host: turned off there after the move, still on here.
    // on-on-host: off here before the move, turned on there after.
    const w = world(
      { 'off-on-host': false, 'on-on-host': true },
      { 'off-on-host': true, 'on-on-host': false }
    )
    const stop = await stopWslMoveHostAutomations(
      userDataPath,
      MOVE,
      ['off-on-host', 'on-on-host'],
      w.ports
    )
    if (stop.outcome !== 'stopped') {
      throw new Error('expected stopped')
    }
    expect(Object.fromEntries(w.host)).toEqual({ 'off-on-host': false, 'on-on-host': false })
    // Nothing here changes before the release step.
    expect(Object.fromEntries(w.local)).toEqual({ 'off-on-host': true, 'on-on-host': false })
    const revert = stop.applyHere()
    expect(Object.fromEntries(w.local)).toEqual({ 'off-on-host': false, 'on-on-host': true })
    revert()
    expect(Object.fromEntries(w.local)).toEqual({ 'off-on-host': true, 'on-on-host': false })
  })

  it('a refusal turns back on what it turned off and forgets what it recorded', async () => {
    const w = world({ a: true, b: false }, { a: true, b: true })
    const stop = await stopWslMoveHostAutomations(userDataPath, MOVE, ['a', 'b'], w.ports)
    expect(cutover()?.undoHostAutomationIntent).toEqual({ a: true, b: false })
    if (stop.outcome !== 'stopped') {
      throw new Error('expected stopped')
    }
    await stop.restore()
    expect(Object.fromEntries(w.host)).toEqual({ a: true, b: false })
    expect(cutover()?.undoHostAutomationIntent).toBeUndefined()
    expect(cutover()?.hostAutomationsLeftOff).toBeUndefined()
  })

  it('records what a refusal could not turn back on, and a later undo keeps it on here', async () => {
    const w = world({ a: true }, { a: true })
    const first = await stopWslMoveHostAutomations(userDataPath, MOVE, ['a'], w.ports)
    w.fail.restore = true
    if (first.outcome !== 'stopped') {
      throw new Error('expected stopped')
    }
    await first.restore()
    expect(w.host.get('a')).toBe(false)
    expect(listUnfinishedWslMoves(userDataPath)).toEqual([
      { migrationId: MOVE, distro: 'Ubuntu', automationsPending: ['a'] }
    ])
    // d3a #1: off on the host only through the failed rollback; the user's choice is still on.
    w.fail.restore = false
    const second = await stopWslMoveHostAutomations(userDataPath, MOVE, ['a'], w.ports)
    if (second.outcome !== 'stopped') {
      throw new Error('expected stopped')
    }
    second.applyHere()
    expect(w.local.get('a')).toBe(true)
  })

  it('records what the host dropped mid-loop left off, and shows it in the notice', async () => {
    const w = world({ a: true, b: true }, { a: true, b: true })
    w.fail.disableAt = 'b'
    const stop = await stopWslMoveHostAutomations(userDataPath, MOVE, ['a', 'b'], w.ports)
    expect(stop).toEqual({ outcome: 'failed' })
    expect(cutover()?.hostAutomationsLeftOff).toEqual(['a'])
    // Only the left-off one keeps its recorded choice for a later undo.
    expect(cutover()?.undoHostAutomationIntent).toEqual({ a: true })
    expect(listUnfinishedWslMoves(userDataPath)[0]?.automationsPending).toEqual(['a'])
  })

  it('the retry turns left-off ones back on and clears them', async () => {
    const w = world({ a: true }, { a: true })
    w.fail.restore = true
    const stop = await stopWslMoveHostAutomations(userDataPath, MOVE, ['a'], w.ports)
    if (stop.outcome === 'stopped') {
      await stop.restore()
    }
    const disable = async () => {}
    expect(
      await retryWslMoveHostAutomationsLeftOff(userDataPath, {
        restore: async () => {
          throw new Error('unreachable')
        },
        disable
      })
    ).toBe(true)
    const turnedOn = vi.fn(async () => {})
    expect(
      await retryWslMoveHostAutomationsLeftOff(userDataPath, { restore: turnedOn, disable })
    ).toBe(false)
    expect(turnedOn).toHaveBeenCalledWith('wsl:Ubuntu', ['a'])
    expect(cutover()?.hostAutomationsLeftOff).toBeUndefined()
    expect(cutover()?.undoHostAutomationIntent).toBeUndefined()
  })

  // d3-gate-audit / d3a #1: a retry mid-RPC while an undo releases the move.
  it('takes turns with an undo, so a released move is neither resurrected nor left on the host', async () => {
    const w = world({ a: true }, { a: true })
    w.fail.restore = true
    const stop = await stopWslMoveHostAutomations(userDataPath, MOVE, ['a'], w.ports)
    if (stop.outcome === 'stopped') {
      await stop.restore()
    }
    w.fail.restore = false
    const order: string[] = []
    let finishRestore = () => {}
    const retry = retryWslMoveHostAutomationsLeftOff(userDataPath, {
      restore: async (_env, ids) => {
        order.push('retry restore')
        await new Promise<void>((resolve) => {
          finishRestore = resolve
        })
        for (const id of ids) {
          w.host.set(id, true)
        }
      },
      disable: async () => {}
    })
    // The undo waits for the retry's turn, then turns the host copy off and releases.
    const undo = runWslMoveHostAutomationsExclusive(async () => {
      order.push('undo')
      const again = await stopWslMoveHostAutomations(userDataPath, MOVE, ['a'], w.ports)
      if (again.outcome === 'stopped') {
        again.applyHere()
      }
      removeCommittedWslMoveCutover(userDataPath, MOVE)
    })
    await vi.waitFor(() => expect(order).toEqual(['retry restore']))
    finishRestore()
    await Promise.all([retry, undo])
    expect(order).toEqual(['retry restore', 'undo'])
    expect(w.host.get('a')).toBe(false)
    expect(w.local.get('a')).toBe(true)
    expect(listWslMoveCutovers(userDataPath)).toEqual([])
  })

  it('a retry finding the move released writes nothing back and turns its host copies off again', async () => {
    const w = world({ a: true }, { a: true })
    w.fail.restore = true
    const stop = await stopWslMoveHostAutomations(userDataPath, MOVE, ['a'], w.ports)
    if (stop.outcome === 'stopped') {
      await stop.restore()
    }
    expect(w.host.get('a')).toBe(false)
    const disable = vi.fn(async (_env: string, ids: readonly string[]) => {
      for (const id of ids) {
        w.host.set(id, false)
      }
    })
    expect(
      await retryWslMoveHostAutomationsLeftOff(userDataPath, {
        restore: async (_env, ids) => {
          for (const id of ids) {
            w.host.set(id, true)
          }
          // The move is released by another route during the host round trip.
          removeCommittedWslMoveCutover(userDataPath, MOVE)
        },
        disable
      })
    ).toBe(false)
    expect(listWslMoveCutovers(userDataPath)).toEqual([])
    // The project is local again: the host copy this retry turned on goes back off.
    expect(disable).toHaveBeenCalledWith('wsl:Ubuntu', ['a'])
    expect(w.host.get('a')).toBe(false)
  })

  it('at startup, an undo a crash interrupted sends what it read as on back on', async () => {
    const w = world({ a: true, b: false }, { a: true, b: true })
    await stopWslMoveHostAutomations(userDataPath, MOVE, ['a', 'b'], w.ports)
    // Crash here: the host copies are off, the record holds the choice.
    settleInterruptedWslMoveUndos(userDataPath)
    // The left-off one keeps its choice for a later undo; the rest clears.
    expect(cutover()?.undoHostAutomationIntent).toEqual({ a: true })
    expect(cutover()?.hostAutomationsLeftOff).toEqual(['a'])
  })

  // d3a: a restart cleared the record, so a later undo read the left-off one as the user's "off".
  it('a later undo after a restart and failed retries still keeps a left-off one on here', async () => {
    const w = world({ a: true }, { a: true })
    w.fail.restore = true
    const refused = await stopWslMoveHostAutomations(userDataPath, MOVE, ['a'], w.ports)
    if (refused.outcome === 'stopped') {
      await refused.restore()
    }
    settleInterruptedWslMoveUndos(userDataPath)
    const unreachable = {
      restore: async () => {
        throw new Error('unreachable')
      },
      disable: async () => {}
    }
    expect(await retryWslMoveHostAutomationsLeftOff(userDataPath, unreachable)).toBe(true)
    expect(await retryWslMoveHostAutomationsLeftOff(userDataPath, unreachable)).toBe(true)
    expect(w.host.get('a')).toBe(false)
    w.fail.restore = false
    const later = await stopWslMoveHostAutomations(userDataPath, MOVE, ['a'], w.ports)
    if (later.outcome !== 'stopped') {
      throw new Error('expected stopped')
    }
    later.applyHere()
    expect(w.local.get('a')).toBe(true)
  })

  it('treats a left-off one as on even when only the left-off list survives', async () => {
    const seeded = cutover()
    if (!seeded) {
      throw new Error('expected the move')
    }
    // Only the left-off list survives (an older build dropped the recorded choice).
    writeWslMoveCutover(userDataPath, { ...seeded, hostAutomationsLeftOff: ['a'] })
    const w = world({ a: false }, { a: true })
    const stop = await stopWslMoveHostAutomations(userDataPath, MOVE, ['a'], w.ports)
    if (stop.outcome !== 'stopped') {
      throw new Error('expected stopped')
    }
    stop.applyHere()
    expect(w.local.get('a')).toBe(true)
  })

  it('a revert that fails for one copy here still puts the others back', async () => {
    const w = world({ a: false, b: false }, { a: true, b: true })
    const failRevertOf: { id: string | null } = { id: null }
    const ports = {
      ...w.ports,
      setHere: (id: string, enabled: boolean) => {
        if (id === failRevertOf.id) {
          throw new Error('store busy')
        }
        w.local.set(id, enabled)
      }
    }
    const stop = await stopWslMoveHostAutomations(userDataPath, MOVE, ['a', 'b'], ports)
    if (stop.outcome !== 'stopped') {
      throw new Error('expected stopped')
    }
    const revert = stop.applyHere()
    expect(Object.fromEntries(w.local)).toEqual({ a: false, b: false })
    failRevertOf.id = 'a'
    revert()
    expect(Object.fromEntries(w.local)).toEqual({ a: false, b: true })
  })
})
