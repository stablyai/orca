import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  activateControl: vi.fn(),
  readControlPoint: vi.fn(),
  readState: vi.fn(),
  readStablePoint: vi.fn(),
  readTextPoint: vi.fn(),
  setInput: vi.fn(),
  tapPoint: vi.fn(),
  waitForDocument: vi.fn()
}))

vi.mock('../../scripts/hosted-webview-cdp-session.mjs', () => ({
  activateHostedWebViewControl: mocks.activateControl,
  readHostedWebViewState: mocks.readState,
  readHostedWebViewTextPoint: mocks.readTextPoint,
  setHostedWebViewInput: mocks.setInput,
  waitForVisibleHostedWebView: mocks.waitForDocument
}))

vi.mock('../../scripts/hosted-android-emulator-accessibility.mjs', () => ({
  tapHostedAndroidPoint: mocks.tapPoint
}))

vi.mock('../../scripts/hosted-android-webview-touch-point.mjs', () => ({
  readStableHostedAndroidWebViewPoint: mocks.readStablePoint
}))

vi.mock('../../scripts/hosted-webview-control-point.mjs', () => ({
  readHostedWebViewControlPoint: mocks.readControlPoint
}))

import { verifyHostedAndroidAgentHistoryJourney } from '../../scripts/hosted-android-agent-history-journey.mjs'

describe('hosted Android Agent History journey', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.activateControl.mockResolvedValue(undefined)
    mocks.readControlPoint.mockResolvedValue({ x: 0.4, y: 0.3 })
    mocks.readStablePoint.mockImplementation((readPoint) => readPoint())
    mocks.readTextPoint.mockResolvedValue({ x: 0.5, y: 0.4 })
    mocks.setInput.mockResolvedValue(undefined)
    mocks.tapPoint.mockImplementation((_emulator, point) => point)
    mocks.readState.mockResolvedValue({
      href: 'orca-mobile-web://build/h/host/agent-history/workspace',
      bodyText: 'Workspace Project All',
      labels: ['Back', 'Refresh agent sessions', 'Resume agent session'],
      placeholders: ['Search sessions, repo:, path:']
    })
    mocks.waitForDocument.mockImplementation(({ expectedHrefIncludes, expectedText }) => ({
      href: `orca-mobile-web://build/h/host${
        expectedHrefIncludes ??
        (expectedText === '2 tabs' || expectedText === 'Agent History'
          ? '/session/'
          : '/agent-history/')
      }workspace`
    }))
  })

  it('covers the existing scopes, preview, search, native resume, and Back flow', async () => {
    const sessionDocument = {
      href: 'orca-mobile-web://build/h/host/session/workspace'
    }

    const result = await verifyHostedAndroidAgentHistoryJourney({
      discoveryUrl: 'http://127.0.0.1:9222',
      emulator: { adb: '/sdk/adb' },
      sessionDocument,
      timeoutMs: 30_000
    })

    const { returnedSessionDocument, ...evidence } = result
    expect(evidence).toEqual({
      route: 'orca-mobile-web://build/h/host/agent-history/workspace',
      scopes: ['Workspace', 'Project', 'All'],
      search: 'present',
      row: 'Hybrid Agent History Fixture',
      preview: 'E2E_AGENT_HISTORY_PREVIEW_MARKER',
      resume: {
        native: 'queued',
        nativeTouchPoint: { x: 0.4, y: 0.3 },
        resumedRoute: 'orca-mobile-web://build/h/host/session/workspace'
      },
      headerControls: ['Back', 'Refresh agent sessions']
    })
    expect(returnedSessionDocument.href).toContain('/session/')
    expect(mocks.setInput).toHaveBeenNthCalledWith(1, expect.anything(), {
      placeholder: 'Search sessions, repo:, path:',
      value: 'NO_MATCHING_AGENT_HISTORY_SESSION'
    })
    expect(mocks.setInput).toHaveBeenNthCalledWith(2, expect.anything(), {
      placeholder: 'Search sessions, repo:, path:',
      value: ''
    })
    expect(mocks.readControlPoint.mock.calls.map((call) => call[1])).toEqual([
      'More session actions',
      'Resume agent session'
    ])
    expect(mocks.readTextPoint.mock.calls.map((call) => call[1])).toEqual(['Agent History'])
    expect(mocks.tapPoint).toHaveBeenCalledTimes(3)
  })
})
