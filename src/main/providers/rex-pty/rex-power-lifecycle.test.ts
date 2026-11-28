import { describe, expect, it, vi } from 'vitest'
import { RexPowerLifecycle, type RexWakeVerdict } from './rex-power-lifecycle'

describe('Rex OS power lifecycle', () => {
  it('holds input until a successful wake proof, with no process action during suspend', async () => {
    const power = new RexPowerLifecycle()
    const key = { id: 'rex-test' }
    const probe = vi.fn(async (): Promise<RexWakeVerdict> => 'healthy')
    const lost = vi.fn()
    const off = power.register(key, probe, lost)
    power.suspend()
    expect(power.isHeld(key)).toBe(true)
    expect(probe).not.toHaveBeenCalled()
    const resume = power.resume()
    expect(power.isHeld(key)).toBe(true)
    await resume
    expect(power.isHeld(key)).toBe(false)
    expect(probe).toHaveBeenCalledTimes(1)
    expect(lost).not.toHaveBeenCalled()
    off()
  })
  it('distinguishes data failure from lost control and discards obsolete proofs', async () => {
    const power = new RexPowerLifecycle()
    const key = { id: 'rex-test' }
    let settle: (value: RexWakeVerdict) => void = () => {}
    const probe = vi.fn(
      () =>
        new Promise<RexWakeVerdict>((resolve) => {
          settle = resolve
        })
    )
    const lost = vi.fn()
    power.register(key, probe, lost)
    power.suspend()
    const first = power.resume()
    power.suspend()
    settle('control-lost')
    await first
    expect(lost).not.toHaveBeenCalled()
    expect(power.isHeld(key)).toBe(true)
    const second = power.resume()
    settle('data-lost')
    await second
    expect(lost).toHaveBeenCalledExactlyOnceWith(true)
    expect(power.isHeld(key)).toBe(false)
  })
  it('keeps input fenced when an older wake proof settles after a second resume', async () => {
    const power = new RexPowerLifecycle()
    const key = { id: 'rex-test' }
    const pending: ((verdict: RexWakeVerdict) => void)[] = []
    let secondProbeStarted!: () => void
    const secondProbe = new Promise<void>((resolve) => {
      secondProbeStarted = resolve
    })
    const lost = vi.fn()
    power.register(
      key,
      () =>
        new Promise<RexWakeVerdict>((resolve) => {
          pending.push(resolve)
          if (pending.length === 2) {
            secondProbeStarted()
          }
        }),
      lost
    )
    power.suspend()
    const first = power.resume()
    power.suspend()
    const second = power.resume()
    pending[0]('healthy')
    expect(await Promise.race([secondProbe.then(() => true), first.then(() => false)])).toBe(true)
    expect(power.isHeld(key)).toBe(true)
    pending[1]('data-lost')
    await Promise.all([first, second])
    expect(power.isHeld(key)).toBe(false)
    expect(lost).toHaveBeenCalledExactlyOnceWith(true)
  })
  it('does not publish a wake failure for a detached session', async () => {
    const power = new RexPowerLifecycle()
    const key = { id: 'rex-test' }
    const lost = vi.fn()
    const off = power.register(
      key,
      async () => {
        throw new Error('closed')
      },
      lost
    )
    const pending = power.resume()
    off()
    await pending
    expect(lost).not.toHaveBeenCalled()
  })
  it('limits concurrent checks to eight', async () => {
    const power = new RexPowerLifecycle()
    let active = 0
    let max = 0
    const lost = vi.fn()
    for (let i = 0; i < 25; i++) {
      power.register(
        { id: `rex-${i}` },
        async () => {
          max = Math.max(max, ++active)
          await Promise.resolve()
          active--
          return 'healthy'
        },
        lost
      )
    }
    await power.resume()
    expect(max).toBe(8)
    expect(lost).not.toHaveBeenCalled()
  })
})
