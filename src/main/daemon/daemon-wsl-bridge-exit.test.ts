import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WslRunningDistrosRead } from '../wsl-background-distro-gate'
import {
  _resetRunningWslDistroCacheForTests,
  resolveRunningWslDistros
} from '../wsl-running-distro-cache'
import { isWslBridgeDistroLost } from './daemon-wsl-bridge-exit'

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

describe('isWslBridgeDistroLost', () => {
  it('spawns one running-list probe for many panes a terminate exits at once', async () => {
    let answer: (distros: string[]) => void = () => {}
    const probe = vi.fn(
      () =>
        new Promise<string[]>((resolve) => {
          answer = resolve
        })
    )
    const exitAt = performance.now()
    const checks = [1, 2, 3].map(() => isWslBridgeDistroLost('Ubuntu', exitAt, readRunning(probe)))
    answer(['Debian'])

    await expect(Promise.all(checks)).resolves.toEqual([true, true, true])
    expect(probe).toHaveBeenCalledOnce()
  })

  it('matches the distro case-insensitively, and a running distro is not lost', async () => {
    await expect(
      isWslBridgeDistroLost('ubuntu', 0, async () => ({ status: 'confirmed', distros: ['Ubuntu'] }))
    ).resolves.toBe(false)
  })

  it('treats a hung check as unanswered, so the exit stays an exit', async () => {
    await expect(isWslBridgeDistroLost('Ubuntu', 0, () => new Promise(() => {}), 10)).resolves.toBe(
      false
    )
  })

  it('treats a failed check as unanswered', async () => {
    await expect(
      isWslBridgeDistroLost('Ubuntu', 0, async () => {
        throw new Error('wsl.exe missing')
      })
    ).resolves.toBe(false)
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

    const checks = [1, 2].map(() => isWslBridgeDistroLost('Ubuntu', exitAt, readRunning(probe)))
    answers[0]!([])
    await background
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2))
    answers[1]!(['Ubuntu'])

    // The user's own `exit`: the distro runs, so the exit stays an exit.
    await expect(Promise.all(checks)).resolves.toEqual([false, false])
  })
})
