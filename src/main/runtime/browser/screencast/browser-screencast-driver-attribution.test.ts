import '../../rpc/unused-default-rpc-methods.test-fixture'
/** Shared screencast subscriptions must not give desktop/web/CLI viewers a phone's input lock. */
import { describe, expect, it, vi } from 'vitest'
import {
  createScreencastHarness,
  HARNESS_PAGE_ID as PAGE
} from './browser-screencast-subscriber-test-harness'

vi.mock('electron', () => ({
  ipcMain: { on: vi.fn(), removeListener: vi.fn(), handle: vi.fn(), removeHandler: vi.fn() },
  webContents: { fromId: vi.fn() }
}))

describe('browser screencast driver attribution', () => {
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
