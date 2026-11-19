import { describe, expect, it } from 'vitest'
import { AwayRestartController } from './away-restart-controller'

function createHarness() {
  const state: {
    eligible: boolean
    away: boolean | undefined
    idle: number
    work: string | null
  } = {
    eligible: true,
    away: true,
    idle: 740,
    work: null
  }
  const restarts: string[] = []
  const scheduled: { run: () => void; at: number }[] = []
  let now = 0
  const controller = new AwayRestartController({
    isEligible: () => state.eligible,
    readAway: () => state.away,
    readIdleSeconds: () => state.idle,
    findInterruptingWork: () => state.work,
    now: () => now,
    schedule: (run, delayMs) => {
      const job = { run, at: now + delayMs }
      scheduled.push(job)
      return () => {
        const index = scheduled.indexOf(job)
        if (index !== -1) {
          scheduled.splice(index, 1)
        }
      }
    },
    publish: () => {},
    requestRestart: (version) => {
      restarts.push(version)
      return true
    },
    record: () => {}
  })
  function runNext(): void {
    const job = scheduled.shift()
    if (job) {
      now = job.at
      job.run()
    }
  }
  function runThrough(deadline: number): void {
    while (scheduled[0] && scheduled[0].at <= deadline) {
      runNext()
    }
  }
  controller.follow({ state: 'downloaded', version: '1.2.3' })
  return { controller, state, restarts, runNext, runThrough }
}

describe('AwayRestartController', () => {
  it('requests a restart when the user stays away and no work interrupts it', () => {
    const { restarts, runThrough } = createHarness()

    runThrough(70_000)

    expect(restarts).toEqual(['1.2.3'])
  })

  it('cancels a due restart when the user returns before confirmation', () => {
    const { controller, state, runThrough } = createHarness()
    runThrough(70_000)

    expect(controller.countdownDeadline('1.2.3')).toBe(70_000)

    state.away = false

    expect(controller.confirmUnattendedRestart()).toBe(false)
    expect(controller.countdownDeadline('1.2.3')).toBeNull()
  })

  it('expires a due restart if the renderer never confirms it', () => {
    const { controller, restarts, runThrough } = createHarness()
    runThrough(101_000)

    expect(restarts).toEqual(['1.2.3'])
    expect(controller.countdownDeadline('1.2.3')).toBeNull()
    expect(controller.confirmUnattendedRestart()).toBe(false)
  })

  it('cancels on input and waits to see the user present before starting again', () => {
    const { controller, state, restarts, runNext, runThrough } = createHarness()
    runNext()
    state.idle = 2
    runThrough(140_000)

    expect(restarts).toEqual([])
    expect(controller.countdownDeadline('1.2.3')).toBeNull()

    state.away = false
    controller.evaluateNow()
    state.idle = 800
    state.away = true
    controller.evaluateNow()

    expect(controller.countdownDeadline('1.2.3')).not.toBeNull()
  })

  it('waits for interrupting work to finish before starting a countdown', () => {
    const { controller, state, runNext } = createHarness()
    state.work = 'native-chat-turn'
    runNext()

    expect(controller.countdownDeadline('1.2.3')).toBeNull()

    state.work = null
    runNext()

    expect(controller.countdownDeadline('1.2.3')).not.toBeNull()
  })

  it('cancels when the screen unlocks without a change in idle time', () => {
    const { controller, state, restarts, runThrough } = createHarness()
    state.idle = 0
    controller.evaluateNow()

    expect(controller.countdownDeadline('1.2.3')).not.toBeNull()

    state.away = false
    runThrough(10_000)

    expect(restarts).toEqual([])
    expect(controller.countdownDeadline('1.2.3')).toBeNull()
  })

  it('keeps waiting when away state is unknown', () => {
    const { controller, state, restarts, runNext, runThrough } = createHarness()
    state.away = undefined
    runNext()

    expect(controller.countdownDeadline('1.2.3')).toBeNull()

    runThrough(300_000)

    expect(controller.countdownDeadline('1.2.3')).toBeNull()
    expect(restarts).toEqual([])
  })

  it('does not restart the declined update and allows a newer version', () => {
    const { controller, restarts, runNext, runThrough } = createHarness()
    runNext()
    controller.decline()
    runThrough(140_000)

    expect(restarts).toEqual([])
    expect(controller.countdownDeadline('1.2.3')).toBeNull()

    controller.follow({ state: 'downloaded', version: '1.2.4' })
    runNext()

    expect(controller.countdownDeadline('1.2.4')).not.toBeNull()
  })

  it('cancels the countdown when eligibility changes', () => {
    const { controller, state, restarts, runNext, runThrough } = createHarness()
    runNext()
    state.eligible = false
    runThrough(140_000)

    expect(controller.countdownDeadline('1.2.3')).toBeNull()
    expect(restarts).toEqual([])
  })
})
