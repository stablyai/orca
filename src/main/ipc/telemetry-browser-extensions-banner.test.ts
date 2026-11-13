import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence/loading-store/store'

const { handleMock, trackMock, assignMock, trusted } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  trackMock: vi.fn(() => true),
  assignMock: vi.fn(async () => ({ status: 'active', banner: 'plain_bring' })),
  trusted: { value: true }
}))

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: vi.fn() },
  ipcMain: { handle: handleMock }
}))
vi.mock('../telemetry/client', () => ({
  hasTrackedAgentDashboardActiveToday: vi.fn(() => false),
  persistBannerAcknowledgeWithoutEmitting: vi.fn(),
  setOptIn: vi.fn(),
  track: trackMock
}))
vi.mock('../telemetry/browser-extensions-banner', () => ({
  assignBrowserExtensionsBanner: assignMock,
  initBrowserExtensionsBanner: vi.fn()
}))
vi.mock('./browser/browser-renderer-trust', () => ({
  isTrustedBrowserRenderer: () => trusted.value
}))

import { registerTelemetryHandlers } from './telemetry'
import { sanitizeRendererSettingsUpdate } from './renderer-settings-update'

function handler(channel: string): (...args: unknown[]) => unknown {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: no handler under test reads the store.
  registerTelemetryHandlers({} as Store)
  return handleMock.mock.calls.findLast(([name]) => name === channel)![1]
}

beforeEach(() => {
  vi.clearAllMocks()
  trusted.value = true
})

describe('browser extensions banner over IPC', () => {
  it('answers only the app window', async () => {
    const assign = handler('telemetry:assignBrowserExtensionsBanner')

    trusted.value = false
    expect(await assign({ sender: {} })).toEqual({ status: 'not_ready' })
    expect(assignMock).not.toHaveBeenCalled()

    trusted.value = true
    expect(await assign({ sender: {} })).toEqual({ status: 'active', banner: 'plain_bring' })
  })

  it('does not let a window report what only main observes', () => {
    const track = handler('telemetry:track')
    const sender = { sender: {} }

    expect(
      track(sender, 'browser_extensions_banner_assigned', {
        banner: 'plain_bring',
        had_extensions: false
      })
    ).toBe(false)
    expect(track(sender, 'browser_extension_installed', { source: 'web_store' })).toBe(false)
    expect(track(sender, 'browser_extension_used', {})).toBe(false)
    expect(trackMock).not.toHaveBeenCalled()

    expect(track(sender, 'browser_extensions_banner_action', { action: 'got_it' })).toBe(true)
  })

  it('does not let a window settings write replace the saved banner', () => {
    const sanitized = sanitizeRendererSettingsUpdate({
      telemetry: {
        optedIn: true,
        installId: 'install-1',
        existedBeforeTelemetryRelease: false,
        browserExtensionsBanner: {
          banner: 'none',
          assignedAt: 1,
          hadExtensions: false,
          reported: true
        }
      }
    })

    expect(sanitized.telemetry).toEqual({
      optedIn: true,
      installId: 'install-1',
      existedBeforeTelemetryRelease: false
    })
  })
})
