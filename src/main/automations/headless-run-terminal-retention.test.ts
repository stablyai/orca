import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AutomationRun, AutomationRunStatus } from '../../shared/automations-types'
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
    dispatchedAt,
    startedAt: dispatchedAt,
    createdAt: dispatchedAt
  } as AutomationRun
}

function harness(runs: AutomationRun[]) {
  const closed: string[] = []
  const forgotten: AutomationRun[] = []
  const use = new Map<string, 'used' | 'unused' | 'unknown'>()
  // Runs whose shell is proven alone at its prompt; any other is unproven, as a live agent reads.
  const idleShell = new Set<string>()
  const dead = new Set<string>()
  const retention = createHeadlessRunTerminalRetention({
    listRuns: () => runs.filter((run) => !forgotten.some((gone) => gone.id === run.id)),
    terminalClientUse: (run) => use.get(run.id) ?? 'unused',
    runTerminalAlive: (run) => !dead.has(run.id),
    shellAloneAtPrompt: async (run) => idleShell.has(run.id),
    closeRunTerminal: async (run) => {
      closed.push(run.terminalPaneKey ?? '')
      return true
    },
    forgetRunTerminal: async (run) => {
      forgotten.push(run)
    }
  })
  return { retention, closed, forgotten, use, idleShell, dead }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('headless run terminal retention', () => {
  it('closes finished run terminals past the grace period, keeping the newest few viewable', async () => {
    // Six hourly runs of one automation, all finished.
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

    // Fresh runs, inside the grace period: an update still releases them.
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

  it('keeps a timed-out run whose agent still runs in its shell', async () => {
    const runs = [
      makeRun('timed-out', 0, 'dispatch_failed'),
      ...[1, 2, 3].map((n) => makeRun(`done${n}`, n))
    ]
    const h = harness(runs)
    await h.retention.sweep()
    vi.advanceTimersByTime(RUN_TERMINAL_GRACE_MS * 10)
    await h.retention.sweep()
    expect(h.closed).toEqual([])
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
    // The newest run's terminal was closed by hand: it must not take a keep slot.
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
})
