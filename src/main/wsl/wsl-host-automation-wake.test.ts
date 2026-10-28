import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Automation } from '../../shared/automations-types'
import { nextAutomationOccurrenceAfter } from '../../shared/automation-schedule-occurrences'
import {
  earliestWslHostAutomationDue,
  nextWslHostAutomationDue,
  readWslHostAutomationWakes,
  WslHostAutomationWake,
  writeWslHostAutomationWakes,
  type WslHostAutomationDue
} from './wsl-host-automation-wake'

const HOUR = 60 * 60 * 1000
const HOURLY = '0 * * * *'

function automation(overrides: Partial<Automation>): Automation {
  return {
    id: 'a',
    name: 'nightly',
    prompt: '',
    precheck: null,
    agentId: 'claude',
    projectId: 'p',
    executionTargetType: 'local',
    executionTargetId: 'p',
    schedulerOwner: 'remote_host_service',
    workspaceMode: 'new_per_run',
    workspaceId: null,
    baseBranch: null,
    reuseSession: false,
    timezone: 'UTC',
    rrule: HOURLY,
    dtstart: 0,
    enabled: true,
    nextRunAt: 10 * HOUR,
    missedRunPolicy: 'run_once_within_grace',
    missedRunGraceMinutes: 720,
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  }
}

function harness(options: { due?: Record<string, WslHostAutomationDue>; connected?: boolean }) {
  let now = 0
  let timer: { at: number; task: () => void } | null = null
  const saved: Record<string, WslHostAutomationDue>[] = []
  const wake = vi.fn(async (_environmentId: string) => {})
  const automations = vi.fn(async (): Promise<Automation[]> => [automation({})])
  const subject = new WslHostAutomationWake({
    load: () => options.due ?? {},
    save: (due) => saved.push(due),
    listAutomations: automations,
    isConnected: async () => options.connected ?? false,
    wake,
    now: () => now,
    setTimer: (delayMs, task) => {
      timer = { at: now + delayMs, task }
      return () => {
        timer = null
      }
    }
  })
  return {
    subject,
    wake,
    automations,
    saved,
    timerAt: () => timer?.at ?? null,
    /** Moves the clock to the armed timer and runs it. */
    async runTimer(at: number) {
      now = at
      const current = timer
      const savesBefore = saved.length
      timer = null
      current?.task()
      await vi.waitFor(() => expect(saved.length).toBeGreaterThan(savesBefore))
    }
  }
}

function due(nextRunAt: number, graceHours = 12): WslHostAutomationDue {
  return {
    nextRunAt,
    wakeUntil: nextRunAt + graceHours * HOUR,
    schedules: [{ rrule: HOURLY, dtstart: 0, missedRunGraceMinutes: graceHours * 60 }]
  }
}

describe('earliestWslHostAutomationDue', () => {
  it('takes the soonest enabled run, its grace window, and every enabled schedule', () => {
    expect(
      earliestWslHostAutomationDue([
        automation({ nextRunAt: 5 * HOUR, enabled: false }),
        automation({ nextRunAt: 8 * HOUR, missedRunGraceMinutes: 60 }),
        automation({ nextRunAt: 9 * HOUR })
      ])
    ).toEqual({
      nextRunAt: 8 * HOUR,
      wakeUntil: 9 * HOUR + 2 * 60_000,
      schedules: [
        { rrule: HOURLY, dtstart: 0, missedRunGraceMinutes: 60 },
        { rrule: HOURLY, dtstart: 0, missedRunGraceMinutes: 720 }
      ]
    })
    expect(earliestWslHostAutomationDue([automation({ enabled: false })])).toBeNull()
  })

  it('computes the following run from the schedules alone', () => {
    const now = 10 * HOUR + 5 * 60_000
    expect(nextWslHostAutomationDue(due(0).schedules, now)?.nextRunAt).toBe(
      nextAutomationOccurrenceAfter(HOURLY, 0, now)
    )
  })
})

describe('WslHostAutomationWake', () => {
  it('boots the host once when a learned run comes due with the host off', async () => {
    const h = harness({})
    await h.subject.learn('wsl:ubuntu')
    expect(h.timerAt()).toBe(HOUR) // capped re-arm, not 10 h
    await h.runTimer(HOUR)
    expect(h.wake).not.toHaveBeenCalled()
    await h.runTimer(10 * HOUR)
    expect(h.wake).toHaveBeenCalledExactlyOnceWith('wsl:ubuntu')
  })

  it('keeps the following run when a due one was handled while the host was connected', async () => {
    const h = harness({ due: { 'wsl:ubuntu': due(-HOUR) }, connected: true })
    h.automations.mockResolvedValueOnce([automation({ nextRunAt: 2 * HOUR })])
    h.subject.start()
    await h.runTimer(0)
    expect(h.wake).not.toHaveBeenCalled()
    // Re-read from the connected host, not dropped.
    expect(h.saved.at(-1)?.['wsl:ubuntu']?.nextRunAt).toBe(2 * HOUR)
  })

  it('keeps the following run when a wake fails or the run is past its grace', async () => {
    const failed = harness({ due: { 'wsl:ubuntu': due(-HOUR) } })
    failed.wake.mockRejectedValueOnce(new Error('boot failed'))
    failed.subject.start()
    await failed.runTimer(0)
    const late = harness({ due: { 'wsl:ubuntu': due(-3 * HOUR, 1) } })
    late.subject.start()
    await late.runTimer(0)
    expect(late.wake).not.toHaveBeenCalled()
    for (const { saved } of [failed, late]) {
      expect(saved.at(-1)?.['wsl:ubuntu']?.nextRunAt).toBe(
        nextAutomationOccurrenceAfter(HOURLY, 0, 0)
      )
    }
  })

  it('fires a run that came due while the computer was off as soon as Orca starts', async () => {
    const h = harness({ due: { 'wsl:ubuntu': due(-HOUR) } })
    h.subject.start()
    expect(h.timerAt()).toBe(0)
    await h.runTimer(0)
    expect(h.wake).toHaveBeenCalledExactlyOnceWith('wsl:ubuntu')
  })

  it('a deleted or disabled automation no longer wakes the host once this desktop re-learns', async () => {
    const h = harness({ due: { 'wsl:ubuntu': due(5 * HOUR) } })
    h.automations.mockResolvedValueOnce([automation({ enabled: false })])
    await h.subject.learn('wsl:ubuntu')
    expect(h.saved.at(-1)).toEqual({})
    expect(h.timerAt()).toBeNull()
  })

  it('keeps what it knew when the host cannot be read, and forgets a removed host', async () => {
    const h = harness({ due: { 'wsl:ubuntu': due(5 * HOUR) } })
    h.automations.mockRejectedValueOnce(new Error('offline'))
    await h.subject.learn('wsl:ubuntu')
    expect(h.saved).toEqual([])
    h.subject.forget('wsl:ubuntu')
    expect(h.saved.at(-1)).toEqual({})
    expect(h.timerAt()).toBeNull()
  })
})

describe('persisted wake times', () => {
  let dir: string | null = null
  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('round-trips and drops malformed entries', () => {
    dir = mkdtempSync(join(tmpdir(), 'orca-wsl-wake-'))
    writeWslHostAutomationWakes(dir, { a: due(1) })
    expect(readWslHostAutomationWakes(dir)).toEqual({ a: due(1) })
    writeFileSync(
      join(dir, 'wsl-host-automation-wakes.json'),
      JSON.stringify({ b: { nextRunAt: 1 } })
    )
    expect(readWslHostAutomationWakes(dir)).toEqual({})
    expect(readWslHostAutomationWakes(join(dir, 'missing'))).toEqual({})
  })
})
