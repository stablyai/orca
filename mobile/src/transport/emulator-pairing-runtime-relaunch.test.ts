import { describe, expect, it, vi } from 'vitest'
import { restartHeadlessPairingRuntime } from '../../scripts/emulator-pairing-runtime-relaunch.mjs'

const lockError = new Error(
  'Temporary desktop runtime exited: Another Orca instance is already running for this userData profile'
)

function runtime() {
  return {
    port: 7331,
    stop: vi.fn(async () => {})
  }
}

describe('emulator pairing runtime relaunch', () => {
  it('retries a transient macOS single-instance lock on the same endpoint', async () => {
    const current = runtime()
    const next = { port: 7331 }
    const start = vi.fn().mockRejectedValueOnce(lockError).mockResolvedValueOnce(next)
    const wait = vi.fn(async () => {})

    await expect(
      restartHeadlessPairingRuntime(current, { enabled: true }, start, wait)
    ).resolves.toBe(next)
    expect(current.stop).toHaveBeenCalledOnce()
    expect(start).toHaveBeenCalledTimes(2)
    expect(start).toHaveBeenNthCalledWith(1, { enabled: true, port: 7331 })
    expect(wait).toHaveBeenCalledWith(250)
  })

  it('does not retry an unrelated startup failure', async () => {
    const current = runtime()
    const error = new Error('address already in use')
    const start = vi.fn().mockRejectedValue(error)
    const wait = vi.fn(async () => {})

    await expect(restartHeadlessPairingRuntime(current, {}, start, wait)).rejects.toBe(error)
    expect(start).toHaveBeenCalledOnce()
    expect(wait).not.toHaveBeenCalled()
  })

  it('holds an E2E host offline long enough to observe native recovery UI', async () => {
    const current = runtime()
    const next = { port: 7331 }
    const start = vi.fn().mockResolvedValue(next)
    const wait = vi.fn(async () => {})

    await expect(
      restartHeadlessPairingRuntime(current, { restartHoldMs: 2_000 }, start, wait)
    ).resolves.toBe(next)
    expect(wait).toHaveBeenCalledOnce()
    expect(wait).toHaveBeenCalledWith(2_000)
  })

  it('bounds repeated transient lock retries', async () => {
    const current = runtime()
    const start = vi.fn().mockRejectedValue(lockError)
    const wait = vi.fn(async () => {})

    await expect(restartHeadlessPairingRuntime(current, {}, start, wait)).rejects.toBe(lockError)
    expect(start).toHaveBeenCalledTimes(20)
    expect(wait).toHaveBeenCalledTimes(19)
  })
})
