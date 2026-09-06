import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  captureScreenshot: vi.fn(),
  compareScreenshots: vi.fn(),
  dismissDeveloperMenu: vi.fn(),
  readTextPoint: vi.fn(),
  tapPoint: vi.fn(),
  waitForControl: vi.fn(),
  waitForControlByPrefix: vi.fn(),
  waitForDocument: vi.fn()
}))

vi.mock('node:child_process', () => ({
  execFile: mocks.captureScreenshot
}))
vi.mock('../../scripts/emulator-developer-menu-dismissal.mjs', () => ({
  dismissEmulatorDeveloperMenuIfPresent: mocks.dismissDeveloperMenu
}))
vi.mock('../../scripts/hosted-ios-emulator-accessibility.mjs', () => ({
  tapHostedIosPoint: mocks.tapPoint,
  waitForHostedIosAccessibilityControl: mocks.waitForControl,
  waitForHostedIosAccessibilityControlByLabelPrefix: mocks.waitForControlByPrefix
}))
vi.mock('../../scripts/hosted-ios-screenshot-parity.mjs', () => ({
  assertHostedIosScreenshotParity: mocks.compareScreenshots
}))
vi.mock('../../scripts/hosted-webview-cdp-session.mjs', () => ({
  readHostedWebViewTextPoint: mocks.readTextPoint,
  waitForVisibleHostedWebView: mocks.waitForDocument
}))

import {
  captureHostedAccountsParity,
  captureNativeAccountsBaseline
} from '../../scripts/hosted-ios-accounts-parity.mjs'

describe('hosted iOS Accounts parity', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.captureScreenshot.mockImplementation((_command, _args, callback) =>
      callback(null, '', '')
    )
    mocks.compareScreenshots.mockResolvedValue({ changedPixelRatio: 0.01 })
    mocks.readTextPoint.mockResolvedValue({ x: 0.2, y: 0.1 })
    mocks.tapPoint.mockResolvedValue(undefined)
    mocks.waitForControl.mockResolvedValue({ x: 0.2, y: 0.1 })
    mocks.waitForControlByPrefix.mockResolvedValue({ x: 0.2, y: 0.1 })
    mocks.waitForDocument.mockImplementation(({ expectedHrefIncludes }) => ({
      href: `orca-mobile-web://build${expectedHrefIncludes ?? '/h/host'}`,
      targetId: expectedHrefIncludes ?? 'workspace'
    }))
  })

  it('captures native Accounts and returns to worktrees', async () => {
    const baseline = await captureNativeAccountsBaseline({
      deviceUdid: 'simulator',
      emulator: { deviceUdid: 'simulator' },
      expectedWorkspace: 'mobile-rearch',
      runtimeDirectory: '/tmp/parity',
      timeoutMs: 30_000
    })

    expect(mocks.tapPoint).toHaveBeenNthCalledWith(
      1,
      { deviceUdid: 'simulator' },
      { x: 0.8, y: 0.1 }
    )
    expect(mocks.waitForControl).toHaveBeenCalledWith(
      { deviceUdid: 'simulator' },
      'Add or re-authenticate accounts from desktop Settings → Accounts.',
      30_000
    )
    expect(baseline).toEqual({
      screenTitlePoint: { x: 0.2, y: 0.1 },
      screenshot: '/tmp/parity/native-accounts-portrait.png'
    })
  })

  it('compares hosted Accounts and returns to the workspace route', async () => {
    const result = await captureHostedAccountsParity({
      deviceUdid: 'simulator',
      discoveryUrl: 'http://127.0.0.1:9222',
      emulator: { deviceUdid: 'simulator' },
      expectedWorkspace: 'mobile-rearch',
      nativeBaseline: {
        screenTitlePoint: { x: 0.2, y: 0.1 },
        screenshot: '/tmp/parity/native-accounts-portrait.png'
      },
      runtimeDirectory: '/tmp/parity',
      timeoutMs: 30_000,
      workspaceDocument: { href: 'orca-mobile-web://build/h/host' }
    })

    expect(mocks.readTextPoint).toHaveBeenCalledWith(expect.anything(), 'Filter')
    expect(mocks.tapPoint).toHaveBeenCalledWith({ deviceUdid: 'simulator' }, { x: 0.8, y: 0.1 })
    expect(mocks.compareScreenshots).toHaveBeenCalledOnce()
    expect(result.evidence.screenshotParity).toEqual({ changedPixelRatio: 0.01 })
    expect(result.workspaceDocument.href).toContain('/h/host')
  })
})
