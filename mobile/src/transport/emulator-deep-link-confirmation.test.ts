import { describe, expect, it, vi } from 'vitest'
import { confirmEmulatorPairingDeepLink } from '../../scripts/emulator-deep-link-confirmation.mjs'

describe('emulator pairing deep-link confirmation', () => {
  it('accepts the iOS system prompt before pairing a fresh install', async () => {
    const emulator = { deviceUdid: 'simulator' }
    const waitForControl = vi.fn().mockResolvedValue({ label: 'Open' })
    const tapControl = vi.fn().mockResolvedValue({ x: 0.5, y: 0.5 })

    await confirmEmulatorPairingDeepLink(emulator, 10_000, waitForControl, tapControl)

    expect(waitForControl).toHaveBeenCalledWith(emulator, ['Open', 'Pair'], 10_000)
    expect(tapControl).toHaveBeenNthCalledWith(1, emulator, 'Open', 10_000)
    expect(tapControl).toHaveBeenNthCalledWith(2, emulator, 'Pair', 10_000)
  })

  it('pairs directly when iOS already trusts the deep link', async () => {
    const emulator = { deviceUdid: 'simulator' }
    const waitForControl = vi.fn().mockResolvedValue({ label: 'Pair' })
    const tapControl = vi.fn().mockResolvedValue({ x: 0.5, y: 0.5 })

    await confirmEmulatorPairingDeepLink(emulator, 10_000, waitForControl, tapControl)

    expect(tapControl).toHaveBeenCalledOnce()
    expect(tapControl).toHaveBeenCalledWith(emulator, 'Pair', 10_000)
  })
})
