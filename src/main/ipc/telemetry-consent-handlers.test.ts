import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handlers, setOptIn } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  setOptIn: vi.fn(async () => undefined)
}))

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    }
  }
}))
vi.mock('../telemetry/client', () => ({
  hasTrackedAgentDashboardActiveToday: () => false,
  persistBannerAcknowledgeWithoutEmitting: async () => undefined,
  setOptIn,
  track: () => false
}))
vi.mock('../telemetry/browser-extensions-banner', () => ({
  assignBrowserExtensionsBanner: () => null,
  initBrowserExtensionsBanner: () => undefined
}))

import { resetBurstCapsForSession } from '../telemetry/burst-cap'
import type { Store } from '../persistence/loading-store/store'
import { _resetStoreForTests, registerTelemetryHandlers } from './telemetry'

function fakeStore(optedIn: boolean | null): Store {
  const settings = {
    telemetry: { installId: 'install', existedBeforeTelemetryRelease: false, optedIn }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the consent handlers read only getSettings().telemetry.
  return { getSettings: () => settings } as unknown as Store
}

function setOptInFromRenderer(optedIn: boolean): unknown {
  return handlers.get('telemetry:setOptIn')?.({}, optedIn)
}

describe('telemetry:setOptIn', () => {
  beforeEach(() => {
    handlers.clear()
    setOptIn.mockClear()
    resetBurstCapsForSession()
    _resetStoreForTests()
  })

  it('still honors opt-out after the consent-change cap is spent on opt-ins', async () => {
    registerTelemetryHandlers(fakeStore(true))
    for (let i = 0; i < 5; i += 1) {
      await setOptInFromRenderer(true)
    }
    await setOptInFromRenderer(true)
    expect(setOptIn).toHaveBeenCalledTimes(5)

    await setOptInFromRenderer(false)
    expect(setOptIn).toHaveBeenLastCalledWith(expect.anything(), false)
    expect(setOptIn).toHaveBeenCalledTimes(6)
  })

  it('ignores a repeat opt-out once telemetry is already off', async () => {
    registerTelemetryHandlers(fakeStore(false))
    await setOptInFromRenderer(false)
    expect(setOptIn).not.toHaveBeenCalled()
  })
})
