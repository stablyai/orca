import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Automation } from '../../shared/automations-types'
import { nextAutomationOccurrenceAfter } from '../../shared/automation-schedule-occurrences'
import { WslHostAutomationWake, type WslHostAutomationDue } from './wsl-host-automation-wake'
import {
  readWslHostAutomationWakes,
  writeWslHostAutomationWakes
} from './wsl-host-automation-wake-store'

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
    setNow(at: number) {
      now = at
    },
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

const MINUTE = 60 * 1000

/** By default the host was last seen ready an hour before the run, so the run was missed. */
function due(
  nextRunAt: number,
  graceHours = 12,
  lastSeenReadyAt = nextRunAt - HOUR
): WslHostAutomationDue {
  return {
    nextRunAt,
    wakeUntil: nextRunAt + graceHours * HOUR,
    schedules: [{ rrule: HOURLY, dtstart: 0, missedRunGraceMinutes: graceHours * 60 }],
    lastSeenReadyAt
  }
}

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

  it('does not boot the host at launch for a run that came due while it was last ready', async () => {
    // The host was ready at 9:50, after the 9 h run: orcad ran it then.
    const h = harness({ due: { 'wsl:ubuntu': due(9 * HOUR, 12, 9 * HOUR + 50 * MINUTE) } })
    h.subject.start()
    await h.runTimer(9 * HOUR + 55 * MINUTE)
    expect(h.wake).not.toHaveBeenCalled()
    expect(h.saved.at(-1)?.['wsl:ubuntu']).toMatchObject({
      nextRunAt: 10 * HOUR,
      lastSeenReadyAt: 9 * HOUR + 50 * MINUTE
    })
  })

  it('still wakes the host once for a later run that came due after it was last ready', async () => {
    // The 8 h run ran while ready (8:30); the 9 h run came due with the host down.
    const h = harness({ due: { 'wsl:ubuntu': due(8 * HOUR, 12, 8 * HOUR + 30 * MINUTE) } })
    h.subject.start()
    await h.runTimer(9 * HOUR + 30 * MINUTE)
    expect(h.wake).toHaveBeenCalledExactlyOnceWith('wsl:ubuntu')
    // The following run is saved before the boot; the re-arm follows it.
    await vi.waitFor(() => expect(h.timerAt()).toBe(10 * HOUR))
  })

  it('saves the following run before booting, so a quit during the boot cannot wake it again', async () => {
    const h = harness({ due: { 'wsl:ubuntu': due(9 * HOUR) } })
    let savedAtWake: number | undefined
    h.wake.mockImplementationOnce(async () => {
      savedAtWake = h.saved.at(-1)?.['wsl:ubuntu']?.nextRunAt
    })
    h.subject.start()
    await h.runTimer(9 * HOUR + 30 * MINUTE)
    expect(h.wake).toHaveBeenCalledOnce()
    expect(savedAtWake).toBe(10 * HOUR)
  })

  it("keeps a fresher ready stamp a learn wrote while an earlier host's wake ran", async () => {
    const h = harness({ due: { 'wsl:a': due(9 * HOUR), 'wsl:b': due(9 * HOUR) } })
    let finishWake: () => void = () => {}
    h.wake.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishWake = resolve
        })
    )
    h.subject.start()
    const fired = h.runTimer(9 * HOUR + 30 * MINUTE)
    await vi.waitFor(() => expect(h.wake).toHaveBeenCalledWith('wsl:a'))
    // b turns ready meanwhile; its read fails, so only the stamp moves.
    h.setNow(9 * HOUR + 40 * MINUTE)
    h.automations.mockRejectedValueOnce(new Error('offline'))
    await h.subject.learn('wsl:b')
    finishWake()
    await fired
    // b's turn in the same fire advances it, and must keep the newer stamp.
    await vi.waitFor(() =>
      expect(h.saved.at(-1)?.['wsl:b']).toMatchObject({
        nextRunAt: 10 * HOUR,
        lastSeenReadyAt: 9 * HOUR + 40 * MINUTE
      })
    )
  })

  it("doesn't wake a host whose entry a learn cleared while an earlier host's wake ran", async () => {
    const h = harness({ due: { 'wsl:a': due(9 * HOUR), 'wsl:b': due(9 * HOUR) } })
    let finishWake: () => void = () => {}
    h.wake.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishWake = resolve
        })
    )
    h.subject.start()
    const fired = h.runTimer(9 * HOUR + 30 * MINUTE)
    await vi.waitFor(() => expect(h.wake).toHaveBeenCalledWith('wsl:a'))
    // b's automations were all deleted meanwhile: a learn finds none and clears its entry.
    h.automations.mockResolvedValueOnce([])
    await h.subject.learn('wsl:b')
    finishWake()
    await fired
    await vi.waitFor(() => expect(h.timerAt()).toBe(10 * HOUR))

    expect(h.wake).toHaveBeenCalledExactlyOnceWith('wsl:a')
    expect(h.saved.at(-1)).not.toHaveProperty('wsl:b')
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
    // Read only while ready: the host still counts as seen ready now.
    expect(h.saved).toEqual([{ 'wsl:ubuntu': due(5 * HOUR, 12, 0) }])
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

  it('reads a file from before lastSeenReadyAt as last ready at its stored run: no boot for it, a wake for later ones', async () => {
    dir = mkdtempSync(join(tmpdir(), 'orca-wsl-wake-'))
    const { lastSeenReadyAt: _dropped, ...oldFormat } = due(8 * HOUR)
    writeFileSync(
      join(dir, 'wsl-host-automation-wakes.json'),
      JSON.stringify({ 'wsl:ubuntu': oldFormat })
    )
    const loaded = readWslHostAutomationWakes(dir)
    expect(loaded['wsl:ubuntu']?.lastSeenReadyAt).toBe(8 * HOUR)

    // Only the stored run is past: it may have run on the host, so nothing boots.
    const stale = harness({ due: loaded })
    stale.subject.start()
    await stale.runTimer(8 * HOUR + 10 * MINUTE)
    expect(stale.wake).not.toHaveBeenCalled()

    // A run after the stored one is genuinely missed: it wakes the host once.
    const missed = harness({ due: loaded })
    missed.subject.start()
    await missed.runTimer(9 * HOUR + 30 * MINUTE)
    expect(missed.wake).toHaveBeenCalledExactlyOnceWith('wsl:ubuntu')
  })
})
