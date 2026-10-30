import './rpc/unused-default-rpc-methods.test-fixture'
/** Shared screencast subscriptions must not give desktop/web/CLI viewers a phone's input lock. */
import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from './orca-runtime'
import { RpcDispatcher } from './rpc/dispatcher'
import { BROWSER_SCREENCAST_METHODS } from './rpc/methods/browser-screencast'
import {
  createScreencastHarness,
  HARNESS_PAGE_ID as PAGE
} from './browser-screencast-subscriber-test-harness'

vi.mock('electron', () => ({
  ipcMain: { on: vi.fn(), removeListener: vi.fn(), handle: vi.fn(), removeHandler: vi.fn() },
  webContents: { fromId: vi.fn() }
}))

describe('browser screencast driver attribution', () => {
  it('takes the mobile presence lock for a phone-scoped subscriber', async () => {
    const { subscribe, driver } = createScreencastHarness()
    const phone = subscribe({ connectionId: 'conn-phone', clientKind: 'mobile' })
    await phone.streaming()
    expect(driver()).toEqual({ kind: 'mobile', clientId: 'conn-phone' })
    phone.stop()
    await phone.done
  })

  it('leaves the page undriven for a paired desktop or web client viewing the same page', async () => {
    const { subscribe, driver } = createScreencastHarness()
    const desktop = subscribe({ connectionId: 'conn-desktop', clientKind: 'runtime' })
    await desktop.streaming()
    expect(driver()).toBeUndefined()
    desktop.stop()
    await desktop.done
  })

  it('leaves the page undriven for an in-process subscriber that reports no pairing scope', async () => {
    const { subscribe, driver } = createScreencastHarness()
    const local = subscribe({ connectionId: 'conn-local' })
    await local.streaming()
    expect(driver()).toBeUndefined()
    local.stop()
    await local.done
  })

  it('releases to idle when the phone leaves while a desktop client keeps watching', async () => {
    const { subscribe, driver } = createScreencastHarness()
    const phone = subscribe({ connectionId: 'conn-phone', clientKind: 'mobile' })
    await phone.streaming()
    const desktop = subscribe({ connectionId: 'conn-desktop', clientKind: 'runtime' })
    await desktop.streaming()
    expect(driver()).toEqual({ kind: 'mobile', clientId: 'conn-phone' })

    phone.stop()
    await phone.done
    expect(driver()).toBeUndefined()
    desktop.stop()
    await desktop.done
  })

  it('hands the lock to a second phone when the first leaves', async () => {
    const { subscribe, driver } = createScreencastHarness()
    const first = subscribe({ connectionId: 'conn-phone-a', clientKind: 'mobile' })
    await first.streaming()
    expect(driver()).toEqual({ kind: 'mobile', clientId: 'conn-phone-a' })
    const second = subscribe({ connectionId: 'conn-phone-b', clientKind: 'mobile' })
    await second.streaming()
    expect(driver()).toEqual({ kind: 'mobile', clientId: 'conn-phone-b' })

    second.stop()
    await second.done
    expect(driver()).toEqual({ kind: 'mobile', clientId: 'conn-phone-a' })
    first.stop()
    await first.done
  })

  it('take-back cancels the phone stream and leaves a desktop viewer streaming', async () => {
    const { runtime, subscribe, driver } = createScreencastHarness()
    const phone = subscribe({ connectionId: 'conn-phone', clientKind: 'mobile' })
    await phone.streaming()
    expect(driver()).toEqual({ kind: 'mobile', clientId: 'conn-phone' })
    const desktop = subscribe({ connectionId: 'conn-desktop', clientKind: 'runtime' })
    await desktop.streaming()

    runtime.reclaimBrowserForDesktop(PAGE)
    await phone.done
    expect(driver()).toEqual({ kind: 'desktop' })
    expect(phone.stops()).toBe(1)
    expect(desktop.stops()).toBe(0)

    desktop.stop()
    await desktop.done
    // Prove the counter can move; zero alone could be a vacuous assertion.
    expect(desktop.stops()).toBeGreaterThan(0)
  })
})

describe('browser.screencast RPC wiring', () => {
  it.each([
    ['mobile', 'mobile'],
    ['runtime', 'runtime'],
    [undefined, undefined]
  ] as const)(
    'forwards the caller pairing scope %s to the runtime',
    async (clientKind, expected) => {
      const browserScreencast = vi.fn(async () => {})
      const runtime = {
        getRuntimeId: () => 'test-runtime',
        browserScreencast,
        cleanupSubscription: vi.fn()
      } as unknown as OrcaRuntimeService
      const dispatcher = new RpcDispatcher({ runtime, methods: BROWSER_SCREENCAST_METHODS })

      await dispatcher.dispatchStreaming(
        { id: 'req-1', authToken: 'tok', method: 'browser.screencast', params: { page: PAGE } },
        () => {},
        { connectionId: 'conn-1', sendBinary: vi.fn(), ...(clientKind ? { clientKind } : {}) }
      )

      expect(browserScreencast).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ connectionId: 'conn-1', clientKind: expected })
      )
    }
  )
})
