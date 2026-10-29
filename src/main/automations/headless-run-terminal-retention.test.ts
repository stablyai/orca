import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AutomationRun, AutomationRunStatus } from '../../shared/automations-types'
import { runKeyedSerializedOperation } from '../cli/keyed-promise-queue'
import {
  createHeadlessRunTerminalRetention,
  RUN_TERMINAL_GRACE_MS,
  RUN_TERMINALS_KEPT_PER_AUTOMATION
} from './headless-run-terminal-retention'

function makeRun(
  id: string,
  dispatchedAt: number,
  status: AutomationRunStatus = 'completed',
  automationId = 'nightly'
): AutomationRun {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: retention reads only these run fields.
  return {
    id,
    automationId,
    status,
    error: status === 'dispatch_failed' ? 'agent missing' : null,
    terminalPaneKey: `tab-${id}:1`,
    terminalPtyId: `pty-${id}`,
    dispatchedAt,
    startedAt: dispatchedAt,
    createdAt: dispatchedAt
  } as AutomationRun
}

function harness(runs: AutomationRun[]) {
  const closed: string[] = []
  const forgotten: AutomationRun[] = []
  const use = new Map<string, 'used' | 'unused' | 'unknown'>()
  const idleShell = new Set<string>()
  const dead = new Set<string>()
  const ownWorkspace = new Set<string>()
  const sleepDeclines = new Set<string>()
  const sleepAttempts: string[] = []
  const slept: string[] = []
  const lanes = new Map<string, Promise<void>>()
  const retention = createHeadlessRunTerminalRetention({
    inAutomationLane: (automationId, operation) =>
      runKeyedSerializedOperation(lanes, automationId, operation),
    listRuns: () => runs.filter((run) => !forgotten.some((gone) => gone.id === run.id)),
    terminalClientUse: (run) => use.get(run.id) ?? 'unused',
    runTerminalAlive: (run) => !dead.has(run.id) && !closed.includes(run.terminalPaneKey ?? ''),
    shellAloneAtPrompt: async (run) => idleShell.has(run.id),
    closeRunTerminal: async (run) => {
      closed.push(run.terminalPaneKey ?? '')
      return true
    },
    runOwnsWorkspace: (run) => ownWorkspace.has(run.id),
    sleepRunWorkspace: async (run) => {
      sleepAttempts.push(run.id)
      if (sleepDeclines.has(run.id)) {
        return false
      }
      slept.push(run.id)
      run.terminalPtyId = null
      return true
    },
    forgetRunTerminal: async (run) => {
      forgotten.push(run)
    }
  })
  return {
    retention,
    closed,
    forgotten,
    use,
    idleShell,
    dead,
    ownWorkspace,
    sleepDeclines,
    sleepAttempts,
    slept,
    lanes
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('headless run terminal retention', () => {
  it('closes finished run terminals past the grace period, keeping the newest few viewable', async () => {
    const runs = [0, 1, 2, 3, 4, 5].map((hour) => makeRun(`r${hour}`, hour * 3_600_000))
    const h = harness(runs)

    await h.retention.sweep()
    expect(h.closed).toEqual([])

    vi.advanceTimersByTime(RUN_TERMINAL_GRACE_MS)
    await h.retention.sweep()
    expect(h.closed.toSorted()).toEqual(['tab-r0:1', 'tab-r1:1', 'tab-r2:1'])
    expect(6 - h.closed.length).toBe(RUN_TERMINALS_KEPT_PER_AUTOMATION)
  })

  it('never closes a run that has not finished, however old', async () => {
    const runs = [
      makeRun('working', 0, 'dispatched'),
      makeRun('starting', 1, 'dispatching'),
      ...[2, 3, 4, 5].map((n) => makeRun(`done${n}`, n))
    ]
    const h = harness(runs)
    await h.retention.sweep()
    vi.advanceTimersByTime(RUN_TERMINAL_GRACE_MS * 10)
    await h.retention.sweep()
    expect(h.closed).toEqual(['tab-done2:1'])
  })

  it.each([
    ['a client typed into since dispatch', 'used'],
    ['a client is attached to or viewing', 'used'],
    ['this host cannot tell whether a client used', 'unknown']
  ] as const)('never closes a terminal %s', async (_case, verdict) => {
    const runs = [0, 1, 2, 3, 4].map((n) => makeRun(`r${n}`, n))
    const h = harness(runs)
    h.use.set('r0', verdict)
    await h.retention.sweep()
    vi.advanceTimersByTime(RUN_TERMINAL_GRACE_MS * 10)
    await h.retention.sweep()
    expect(h.closed).toEqual(['tab-r1:1'])
  })

  it.each(['dispatch_failed', 'skipped_precheck'] as const)(
    'keeps a %s run whose shell is not proven alone, since its agent may still be alive',
    async (status) => {
      const runs = [
        ...[0, 1, 2, 3].map((n) => makeRun(`f${n}`, n, status)),
        ...[4, 5, 6].map((n) => makeRun(`done${n}`, n))
      ]
      const h = harness(runs)
      await h.retention.sweep()
      vi.advanceTimersByTime(RUN_TERMINAL_GRACE_MS * 10)
      await h.retention.sweep()
      expect(h.closed).toEqual([])
    }
  )

  it('keeps the newest few per automation, not across all of them', async () => {
    const runs = [
      ...[0, 1, 2].map((n) => makeRun(`a${n}`, n, 'completed', 'a')),
      ...[0, 1, 2].map((n) => makeRun(`b${n}`, n, 'completed', 'b'))
    ]
    const h = harness(runs)
    await h.retention.sweep()
    vi.advanceTimersByTime(RUN_TERMINAL_GRACE_MS)
    await h.retention.sweep()
    expect(h.closed).toEqual([])
  })

  it('sweeps on its own once started, and stops with the service', async () => {
    const runs = [0, 1, 2, 3].map((n) => makeRun(`r${n}`, n))
    const h = harness(runs)
    h.retention.start()
    await vi.advanceTimersByTimeAsync(RUN_TERMINAL_GRACE_MS + 2 * 60_000)
    expect(h.closed).toEqual(['tab-r0:1'])

    h.retention.stop()
    runs.push(makeRun('r4', 4), makeRun('r5', 5))
    await vi.advanceTimersByTimeAsync(RUN_TERMINAL_GRACE_MS * 2)
    expect(h.closed).toEqual(['tab-r0:1'])
  })

  it('drains every completed, unused run terminal for an update, ignoring keep and grace', async () => {
    const runs = [
      ...[0, 1, 2, 3, 4].map((n) => makeRun(`r${n}`, n)),
      makeRun('typed', 5),
      makeRun('adopted', 6),
      makeRun('failed', 7, 'dispatch_failed'),
      makeRun('working', 8, 'dispatched')
    ]
    const h = harness(runs)
    h.use.set('typed', 'used')
    h.use.set('adopted', 'unknown')

    expect(await h.retention.drain()).toBe(5)
    expect(h.closed.toSorted()).toEqual([
      'tab-r0:1',
      'tab-r1:1',
      'tab-r2:1',
      'tab-r3:1',
      'tab-r4:1'
    ])
  })

  it('closes a failed run whose agent command was not found, once its shell is idle', async () => {
    const runs = [
      makeRun('missing', 0, 'dispatch_failed'),
      ...[1, 2, 3].map((n) => makeRun(`done${n}`, n))
    ]
    const h = harness(runs)
    h.idleShell.add('missing')
    await h.retention.sweep()
    vi.advanceTimersByTime(RUN_TERMINAL_GRACE_MS)
    await h.retention.sweep()
    expect(h.closed).toEqual(['tab-missing:1'])
    expect(h.forgotten[0]).toMatchObject({ id: 'missing', status: 'dispatch_failed' })
  })

  it('closes a still-dispatched run whose agent exited, leaving its shell idle', async () => {
    const runs = [
      makeRun('exited', 0, 'dispatched'),
      ...[1, 2, 3].map((n) => makeRun(`done${n}`, n))
    ]
    const h = harness(runs)
    h.idleShell.add('exited')
    await h.retention.sweep()
    vi.advanceTimersByTime(RUN_TERMINAL_GRACE_MS)
    await h.retention.sweep()
    expect(h.closed).toEqual(['tab-exited:1'])
  })

  it('keeps the newest three live terminals, not counting ones already gone', async () => {
    const runs = [0, 1, 2, 3, 4].map((n) => makeRun(`r${n}`, n))
    const h = harness(runs)
    h.dead.add('r4')
    await h.retention.sweep()
    vi.advanceTimersByTime(RUN_TERMINAL_GRACE_MS)
    await h.retention.sweep()
    expect(h.closed).toEqual(['tab-r0:1'])
    expect(h.forgotten.map((run) => run.id).toSorted()).toEqual(['r0', 'r4'])
  })

  it('drains idle failed and exited runs for an update, never a live agent', async () => {
    const runs = [
      makeRun('missing', 0, 'dispatch_failed'),
      makeRun('exited', 1, 'dispatched'),
      makeRun('timed-out', 2, 'dispatch_failed'),
      makeRun('working', 3, 'dispatched')
    ]
    const h = harness(runs)
    h.idleShell.add('missing')
    h.idleShell.add('exited')
    expect(await h.retention.drain()).toBe(2)
    expect(h.closed.toSorted()).toEqual(['tab-exited:1', 'tab-missing:1'])
  })

  it('keeps older runs linked to a reused pane until its newest run lets it go', async () => {
    const shared = [1, 2, 3, 4, 5].map((n) => ({
      ...makeRun(`r${n}`, n),
      terminalPaneKey: 'tab-shared:1'
    }))
    const h = harness([makeRun('r0', 0), ...shared])
    await h.retention.sweep()
    vi.advanceTimersByTime(RUN_TERMINAL_GRACE_MS * 10)
    await h.retention.sweep()

    expect(h.closed).toEqual([])
    expect(h.forgotten).toEqual([])

    await h.retention.drain()
    expect(h.closed.toSorted()).toEqual(['tab-r0:1', 'tab-shared:1'])
    expect(h.forgotten.map((run) => run.id).toSorted()).toEqual([
      'r0',
      'r1',
      'r2',
      'r3',
      'r4',
      'r5'
    ])
  })

  it('closes nothing while a run of the automation holds its lane, then sees that run', async () => {
    const runs = [0, 1, 2, 3].map((n) => makeRun(`r${n}`, n))
    const h = harness(runs)
    await h.retention.sweep()
    vi.advanceTimersByTime(RUN_TERMINAL_GRACE_MS)

    let finishDispatch = (): void => {}
    const dispatch = runKeyedSerializedOperation(h.lanes, 'nightly', async () => {
      await new Promise<void>((resolve) => (finishDispatch = resolve))
      runs.push({ ...makeRun('reuse', 4, 'dispatched'), terminalPaneKey: 'tab-r0:1' })
    })
    const sweeping = h.retention.sweep()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.closed).toEqual([])

    finishDispatch()
    await dispatch
    await sweeping
    expect(h.closed).toEqual(['tab-r1:1'])
    expect(h.forgotten.map((run) => run.id)).toEqual(['r1'])
  })

  it('a dispatch queued behind a closing sweep never sees the closing pane as free', async () => {
    const runs = [0, 1, 2, 3].map((n) => makeRun(`r${n}`, n))
    const h = harness(runs)
    await h.retention.sweep()
    vi.advanceTimersByTime(RUN_TERMINAL_GRACE_MS)
    let finishClose = (): void => {}
    const closeRunTerminal = vi.fn(
      () => new Promise<boolean>((resolve) => (finishClose = () => resolve(true)))
    )
    const slow = createHeadlessRunTerminalRetention({
      listRuns: () => runs.filter((run) => !h.forgotten.some((gone) => gone.id === run.id)),
      terminalClientUse: () => 'unused',
      runTerminalAlive: () => true,
      shellAloneAtPrompt: async () => false,
      closeRunTerminal,
      runOwnsWorkspace: () => false,
      sleepRunWorkspace: async () => false,
      forgetRunTerminal: async (run) => {
        h.forgotten.push(run)
      },
      inAutomationLane: (automationId, operation) =>
        runKeyedSerializedOperation(h.lanes, automationId, operation)
    })
    await slow.sweep()
    vi.advanceTimersByTime(RUN_TERMINAL_GRACE_MS)

    const sweeping = slow.sweep()
    await vi.advanceTimersByTimeAsync(0)
    expect(closeRunTerminal).toHaveBeenCalledTimes(1)
    const sawForgotten = runKeyedSerializedOperation(h.lanes, 'nightly', async () =>
      h.forgotten.map((run) => run.id)
    )
    finishClose()
    await sweeping
    expect(await sawForgotten).toEqual(['r0'])
  })

  it('sleeps a completed run in its own workspace instead of closing it, and keeps it asleep', async () => {
    const runs = [0, 1, 2, 3].map((n) => makeRun(`r${n}`, n))
    const h = harness(runs)
    h.ownWorkspace.add('r0')
    await h.retention.sweep()
    vi.advanceTimersByTime(RUN_TERMINAL_GRACE_MS)
    await h.retention.sweep()
    expect(h.slept).toEqual(['r0'])
    expect(h.closed).toEqual([])
    expect(h.forgotten).toEqual([])

    await h.retention.sweep()
    await h.retention.drain()
    expect(h.slept).toEqual(['r0'])
    expect(h.forgotten.map((run) => run.id)).not.toContain('r0')
  })

  it('closes a failed run in its own workspace, and never sleeps or closes a used one', async () => {
    const runs = [
      makeRun('failed', 0, 'dispatch_failed'),
      makeRun('typed', 1),
      ...[2, 3, 4].map((n) => makeRun(`done${n}`, n))
    ]
    const h = harness(runs)
    h.ownWorkspace.add('failed')
    h.ownWorkspace.add('typed')
    h.idleShell.add('failed')
    h.use.set('typed', 'used')
    await h.retention.drain()
    expect(h.slept).toEqual([])
    expect(h.closed.toSorted()).toEqual([
      'tab-done2:1',
      'tab-done3:1',
      'tab-done4:1',
      'tab-failed:1'
    ])
  })

  it('keeps a run in its own workspace whose sleep declines or fails, retrying each sweep', async () => {
    const runs = [0, 1, 2, 3].map((n) => makeRun(`r${n}`, n))
    const h = harness(runs)
    h.ownWorkspace.add('r0')
    h.sleepDeclines.add('r0')
    await h.retention.sweep()
    vi.advanceTimersByTime(RUN_TERMINAL_GRACE_MS)
    await h.retention.sweep()
    await h.retention.sweep()
    expect(h.sleepAttempts).toEqual(['r0', 'r0'])
    expect(h.closed).toEqual([])
    expect(h.forgotten).toEqual([])

    h.sleepDeclines.delete('r0')
    await h.retention.sweep()
    expect(h.slept).toEqual(['r0'])
  })
})
