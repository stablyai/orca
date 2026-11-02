import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WslRunningDistrosRead } from '../wsl-background-distro-gate'
import {
  _resetRunningWslDistroCacheForTests,
  resolveRunningWslDistros
} from '../wsl-running-distro-cache'
import { checkWslBridgeDistro } from './daemon-wsl-bridge-exit'

afterEach(() => {
  _resetRunningWslDistroCacheForTests()
})

/** The production reader's shape: the shared, coalesced probe, confirmed or unavailable. */
function readRunning(probe: () => Promise<string[]>) {
  return async (options: { startedAfter?: number }): Promise<WslRunningDistrosRead> => ({
    status: 'confirmed',
    distros: await resolveRunningWslDistros(probe, { requireConfirmed: true, ...options })
  })
}

describe('checkWslBridgeDistro', () => {
  it('spawns one running-list probe for many panes a terminate exits at once', async () => {
    let answer: (distros: string[]) => void = () => {}
    const probe = vi.fn(
      () =>
        new Promise<string[]>((resolve) => {
          answer = resolve
        })
    )
    const exitAt = performance.now()
    const checks = [1, 2, 3].map(() => checkWslBridgeDistro('Ubuntu', exitAt, readRunning(probe)))
    // The checks first wait out the stop's settle anchor, so the probe starts a tick later.
    await vi.waitFor(() => expect(probe).toHaveBeenCalled())
    answer(['Debian'])

    await expect(Promise.all(checks)).resolves.toEqual(['lost', 'lost', 'lost'])
    expect(probe).toHaveBeenCalledOnce()
  })

  it('never trusts a probe already in flight before the exit: one fresh probe follows it', async () => {
    // A background probe started before the pane's shell booted the distro, so it lacks it.
    const answers: ((distros: string[]) => void)[] = []
    const probe = vi.fn(
      () =>
        new Promise<string[]>((resolve) => {
          answers.push(resolve)
        })
    )
    const background = resolveRunningWslDistros(probe)
    const exitAt = performance.now() + 1

    const checks = [1, 2].map(() => checkWslBridgeDistro('Ubuntu', exitAt, readRunning(probe)))
    answers[0]!([])
    await background
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2))
    answers[1]!(['Ubuntu'])

    // The user's own `exit`: the distro runs, so the exit stays an exit.
    await expect(Promise.all(checks)).resolves.toEqual(['running', 'running'])
  })
})
