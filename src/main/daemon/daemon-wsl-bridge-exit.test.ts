import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WslRunningDistrosRead } from '../wsl-background-distro-gate'
import {
  _resetRunningWslDistroCacheForTests,
  resolveRunningWslDistros
} from '../wsl-running-distro-cache'
import { checkWslBridgeDistro, classifyWslBridgeExit } from './daemon-wsl-bridge-exit'

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

  it('matches the distro case-insensitively, and a running distro is not lost', async () => {
    await expect(
      checkWslBridgeDistro('ubuntu', 0, async () => ({ status: 'confirmed', distros: ['Ubuntu'] }))
    ).resolves.toBe('running')
  })

  it('treats a hung check as unanswered, so the exit stays an exit', async () => {
    await expect(
      checkWslBridgeDistro('Ubuntu', 0, () => new Promise(() => {}), { firstMs: 10, totalMs: 30 })
    ).resolves.toBe('unavailable')
  })

  // 5e hardening (b): a slow or failing first read is asked once more before the exit stays an exit.
  it('retries an unanswered read once, past the failure backoff, within the total budget', async () => {
    const reads: { bypassFailureBackoff?: boolean }[] = []
    const answers: WslRunningDistrosRead[] = [
      { status: 'unavailable' },
      { status: 'confirmed', distros: [] }
    ]
    await expect(
      checkWslBridgeDistro('Ubuntu', 0, async (options) => {
        reads.push({ bypassFailureBackoff: options.bypassFailureBackoff })
        return answers.shift() ?? { status: 'unavailable' }
      })
    ).resolves.toBe('lost')
    expect(reads).toEqual([{ bypassFailureBackoff: undefined }, { bypassFailureBackoff: true }])
  })

  it('gives the retry only what is left of the total budget after a hung first read', async () => {
    const reads = vi.fn(() => new Promise<WslRunningDistrosRead>(() => {}))
    const startedAt = performance.now()
    await expect(
      checkWslBridgeDistro('Ubuntu', 0, reads, { firstMs: 20, totalMs: 60 })
    ).resolves.toBe('unavailable')
    expect(reads).toHaveBeenCalledTimes(2)
    expect(performance.now() - startedAt).toBeLessThan(500)
  })

  it('treats a failed check as unanswered', async () => {
    await expect(
      checkWslBridgeDistro('Ubuntu', 0, async () => {
        throw new Error('wsl.exe missing')
      })
    ).resolves.toBe('unavailable')
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

describe('classifyWslBridgeExit', () => {
  const running = async (): Promise<WslRunningDistrosRead> => ({
    status: 'confirmed',
    distros: ['Ubuntu']
  })

  it('calls a running distro that booted again since the spawn rebooted, not an exit', async () => {
    await expect(classifyWslBridgeExit('Ubuntu', 0, running, async () => true)).resolves.toBe(
      'rebooted'
    )
    await expect(classifyWslBridgeExit('Ubuntu', 0, running, async () => false)).resolves.toBe(
      'running'
    )
  })

  it('asks about the boot id only when the running list says running', async () => {
    const rebooted = vi.fn(async () => true)
    await expect(
      classifyWslBridgeExit(
        'Ubuntu',
        0,
        async () => ({ status: 'confirmed', distros: [] }),
        rebooted
      )
    ).resolves.toBe('lost')
    await expect(
      classifyWslBridgeExit('Ubuntu', 0, async () => ({ status: 'unavailable' }), rebooted)
    ).resolves.toBe('unavailable')
    expect(rebooted).not.toHaveBeenCalled()
  })
})
