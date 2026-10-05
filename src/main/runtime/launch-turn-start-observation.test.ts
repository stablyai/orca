import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  LAUNCH_HOOK_SILENCE_MS,
  observeLaunchTurnStart,
  type LaunchTurnStartProbe
} from './launch-turn-start-observation'

/** A hook proof that never arrives, as when an agent's turn carried no prompt the hook saw. */
function pendingHookTurn(signal: AbortSignal): Promise<'unobserved'> {
  return new Promise((resolve) => signal.addEventListener('abort', () => resolve('unobserved')))
}

function probe(overrides: Partial<LaunchTurnStartProbe>): LaunchTurnStartProbe {
  return {
    observeHookTurn: pendingHookTurn,
    hookReachedPane: () => false,
    readWorkingSequence: () => 0,
    dialogOnScreen: () => false,
    launchRecorded: () => true,
    readForeground: async () => 'agent',
    ...overrides
  }
}

describe('observeLaunchTurnStart', () => {
  it('keeps waiting on the hook while hook events reach the pane', async () => {
    await expect(
      observeLaunchTurnStart(probe({ hookReachedPane: () => true }), {
        launchStartedAt: Date.now() - LAUNCH_HOOK_SILENCE_MS,
        timeoutMs: 600
      })
    ).resolves.toBe('unobserved')
  })

  // Why: hooks not installed on a host leave the pane silent; the launch is judged as main judged it.
  it('judges a launch whose hooks stayed silent by the agent holding its terminal', async () => {
    await expect(
      observeLaunchTurnStart(probe({}), {
        launchStartedAt: Date.now() - LAUNCH_HOOK_SILENCE_MS,
        timeoutMs: 600
      })
    ).resolves.toBe('unsupported')
  })

  it('does not judge a launch by its own evidence before its hooks had time to report', async () => {
    await expect(
      observeLaunchTurnStart(probe({}), { launchStartedAt: Date.now(), timeoutMs: 600 })
    ).resolves.toBe('unobserved')
  })

  it('takes the hook proof over the launch evidence', async () => {
    await expect(
      observeLaunchTurnStart(probe({ observeHookTurn: async () => 'observed' }), {
        launchStartedAt: Date.now(),
        timeoutMs: 600
      })
    ).resolves.toBe('observed')
  })

  it('reports an exit only for a launch it saw recorded and then finished', async () => {
    let recorded = true
    setTimeout(() => {
      recorded = false
    }, 100)
    await expect(
      observeLaunchTurnStart(
        probe({ launchRecorded: () => recorded, readForeground: async () => 'shell' }),
        { launchStartedAt: Date.now(), timeoutMs: 600 }
      )
    ).resolves.toBe('exited')
    await expect(
      observeLaunchTurnStart(
        probe({ launchRecorded: () => false, readForeground: async () => 'shell' }),
        { launchStartedAt: Date.now(), timeoutMs: 600 }
      )
    ).resolves.toBe('unobserved')
  })

  // Why pinned: a worker start with hooks off must be no slower than main, which settled on its
  // first evidence; a fixed wait here is the receipt arriving seconds after the brief.
  describe('with hooks off, on fake time', () => {
    afterEach(() => vi.useRealTimers())

    /** The verdict once `ms` of fake time has passed, or `pending`. */
    async function verdictAfter(observing: Promise<string>, ms: number): Promise<string> {
      let verdict = 'pending'
      void observing.then((value) => {
        verdict = value
      })
      await vi.advanceTimersByTimeAsync(ms)
      return verdict
    }

    // The foreground read is a process scan that can take seconds under load; it is the only wait.
    it('takes the agent proven in front as soon as the read answers, with no dialog on screen', async () => {
      vi.useFakeTimers()
      const readForeground = () =>
        new Promise<'agent'>((resolve) => setTimeout(() => resolve('agent'), 4_000))
      const observing = observeLaunchTurnStart(
        probe({ observeHookTurn: undefined, readForeground }),
        { launchStartedAt: Date.now(), timeoutMs: 30_000 }
      )
      await expect(verdictAfter(observing, 3_999)).resolves.toBe('pending')
      await expect(verdictAfter(observing, 1)).resolves.toBe('unsupported')
    })

    it('does not take the agent in front while a startup dialog is on screen', async () => {
      vi.useFakeTimers()
      let dialog = true
      const observing = observeLaunchTurnStart(
        probe({ observeHookTurn: undefined, dialogOnScreen: () => dialog }),
        { launchStartedAt: Date.now(), timeoutMs: 30_000 }
      )
      await expect(verdictAfter(observing, 5_000)).resolves.toBe('pending')
      dialog = false
      await expect(verdictAfter(observing, 1_000)).resolves.toBe('unsupported')
    })
  })

  it('waits the hook silence out, and no longer, when hooks are on but never report', async () => {
    vi.useFakeTimers()
    try {
      let verdict = 'pending'
      void observeLaunchTurnStart(probe({}), {
        launchStartedAt: Date.now(),
        timeoutMs: 30_000
      }).then((value) => {
        verdict = value
      })
      await vi.advanceTimersByTimeAsync(LAUNCH_HOOK_SILENCE_MS - 250)
      expect(verdict).toBe('pending')
      await vi.advanceTimersByTimeAsync(500)
      expect(verdict).toBe('unsupported')
    } finally {
      vi.useRealTimers()
    }
  })
})
