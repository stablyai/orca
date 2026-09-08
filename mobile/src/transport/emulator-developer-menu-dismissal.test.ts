import { describe, expect, it, vi } from 'vitest'
import {
  dismissEmulatorDeveloperMenuBeforePairing,
  dismissEmulatorDeveloperMenuIfPresent
} from '../../scripts/emulator-developer-menu-dismissal.mjs'

describe('emulator developer menu dismissal', () => {
  it('dismisses the first-install developer overlay when present', async () => {
    const tapControl = vi.fn().mockResolvedValue({ x: 0.5, y: 0.5 })
    const emulator = { deviceUdid: 'simulator' }

    await expect(dismissEmulatorDeveloperMenuIfPresent(emulator, tapControl)).resolves.toBe(true)
    expect(tapControl).toHaveBeenNthCalledWith(1, emulator, 'Continue', 2_000)
    expect(tapControl).toHaveBeenNthCalledWith(2, emulator, 'Close', 2_000)
  })

  it('leaves ordinary launches unchanged when the overlay is absent', async () => {
    const tapControl = vi.fn().mockRejectedValue(new Error('not found'))

    await expect(
      dismissEmulatorDeveloperMenuIfPresent({ deviceUdid: 'simulator' }, tapControl)
    ).resolves.toBe(false)
    expect(tapControl).toHaveBeenCalledTimes(2)
  })

  it('dismisses late developer overlays until pairing is accessible', async () => {
    const waitForControl = vi
      .fn()
      .mockResolvedValueOnce({ label: 'Open' })
      .mockResolvedValueOnce({ label: 'Continue' })
      .mockResolvedValueOnce({ label: 'Close' })
      .mockResolvedValueOnce({ label: 'Pair' })
    const tapControl = vi.fn().mockResolvedValue({ x: 0.5, y: 0.5 })
    const emulator = { deviceUdid: 'simulator' }

    await expect(
      dismissEmulatorDeveloperMenuBeforePairing(emulator, 10_000, waitForControl, tapControl)
    ).resolves.toBeUndefined()
    expect(tapControl).toHaveBeenNthCalledWith(1, emulator, 'Open', 2_000)
    expect(tapControl).toHaveBeenNthCalledWith(2, emulator, 'Continue', 2_000)
    expect(tapControl).toHaveBeenNthCalledWith(3, emulator, 'Close', 2_000)
  })
})
