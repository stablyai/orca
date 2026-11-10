import { describe, expect, it, vi } from 'vitest'
import {
  TerminalUpdateAdmission,
  TerminalUpdateAdmissionClosedError
} from './terminal-update-admission'

function admission(live: string[] | null = []) {
  let now = 1_000
  const fence = new TerminalUpdateAdmission(
    async () => live,
    () => now
  )
  return { fence, advance: (ms: number) => (now += ms) }
}

describe('TerminalUpdateAdmission', () => {
  it('lapses on its own, so a desktop that vanished mid-update cannot lock terminals out', async () => {
    const { fence, advance } = admission()
    expect(fence.close(60_000)).toBe(61_000)
    await expect(fence.admit(undefined)).rejects.toBeInstanceOf(TerminalUpdateAdmissionClosedError)
    advance(60_000)
    const admitted = await fence.admit(undefined)
    expect(admitted.attachOnly).toBe(false)
    admitted.release()
  })

  it('admits a reattach to a live session while closed only as attach-only', async () => {
    const { fence } = admission(['pty-live'])
    const requireAttachOnly = vi.fn()
    ;(await fence.hold('pty-live', async () => () => {}, requireAttachOnly))()
    expect(requireAttachOnly).not.toHaveBeenCalled()

    fence.close(60_000)
    ;(await fence.hold('pty-live', async () => () => {}, requireAttachOnly))()
    expect(requireAttachOnly).toHaveBeenCalledTimes(1)
  })

  it('releases admission when the lease it holds cannot be taken', async () => {
    const { fence } = admission()
    await expect(
      fence.hold(
        undefined,
        async () => {
          throw new Error('lock deadline')
        },
        undefined
      )
    ).rejects.toThrow('lock deadline')
    fence.close(60_000)
    await expect(fence.waitForSpawnsToSettle(0)).resolves.toBe(true)
  })

  it('reports a spawn that never settles, and stops waiting for it', async () => {
    vi.useFakeTimers()
    try {
      const { fence } = admission()
      const { release } = await fence.admit(undefined)
      fence.close(60_000)
      const settled = fence.waitForSpawnsToSettle(10_000)
      await vi.advanceTimersByTimeAsync(10_000)
      await expect(settled).resolves.toBe(false)
      release()
      release()
      await expect(fence.waitForSpawnsToSettle(10_000)).resolves.toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
