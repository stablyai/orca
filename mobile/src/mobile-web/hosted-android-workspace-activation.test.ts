import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  activateControl: vi.fn(),
  readTextPoint: vi.fn(),
  tapPoint: vi.fn()
}))

vi.mock('../../scripts/hosted-webview-cdp-session.mjs', () => ({
  activateHostedWebViewControl: mocks.activateControl,
  readHostedWebViewTextPoint: mocks.readTextPoint
}))

vi.mock('../../scripts/hosted-android-emulator-accessibility.mjs', () => ({
  tapHostedAndroidPoint: mocks.tapPoint
}))

import {
  activateHostedAndroidWorkspaceControl,
  prepareHostedAndroidWorkspaceInput
} from '../../scripts/hosted-android-workspace-activation.mjs'

describe('hosted Android workspace activation', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    mocks.activateControl.mockResolvedValue(undefined)
    mocks.readTextPoint.mockResolvedValue({ x: 0.2, y: 0.3 })
    mocks.tapPoint.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('primes WebView focus before workspace input', async () => {
    const emulator = { adb: '/sdk/adb' }
    const result = prepareHostedAndroidWorkspaceInput(emulator)

    await vi.advanceTimersByTimeAsync(10_000)
    await result

    expect(mocks.tapPoint).toHaveBeenCalledWith(emulator, { x: 0.5, y: 0.75 })
  })

  it('uses the grouped text control instead of a non-hittable ARIA node', async () => {
    const document = { href: 'https://orca-mobile-web.invalid/' }

    await expect(
      activateHostedAndroidWorkspaceControl({}, document, {
        kind: 'label',
        value: 'Open mobile-rearch',
        reveal: true
      })
    ).rejects.toThrow('Hosted WebView control was not found')

    await activateHostedAndroidWorkspaceControl({}, document, {
      kind: 'text',
      value: 'mobile-rearch',
      reveal: true
    })

    expect(mocks.activateControl).toHaveBeenCalledOnce()
  })

  it('waits for visible row coordinates to stabilize before tapping', async () => {
    const emulator = { adb: '/sdk/adb' }
    const result = activateHostedAndroidWorkspaceControl(
      emulator,
      {},
      {
        kind: 'text',
        value: 'mobile-rearch',
        occurrence: 1,
        reveal: true
      }
    )

    await vi.advanceTimersByTimeAsync(3_000)
    await result

    expect(mocks.readTextPoint).toHaveBeenCalledWith(
      {},
      'mobile-rearch',
      undefined,
      expect.objectContaining({ occurrence: 1 })
    )
    expect(mocks.tapPoint).toHaveBeenCalledWith(emulator, { x: 0.2, y: 0.3 })
  })
})
