import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  activateControl: vi.fn(),
  activateWorkspace: vi.fn(),
  captureScreenshot: vi.fn(),
  compareScreenshots: vi.fn(),
  dismissDeveloperMenu: vi.fn(),
  readControlPoint: vi.fn(),
  readTextPoint: vi.fn(),
  tapControl: vi.fn(),
  tapControlByPrefix: vi.fn(),
  tapPoint: vi.fn(),
  waitForControl: vi.fn(),
  waitForControlByPrefix: vi.fn(),
  waitForControlMatch: vi.fn(),
  waitForControlMatching: vi.fn(),
  waitForDocument: vi.fn()
}))

vi.mock('node:child_process', () => ({
  execFile: mocks.captureScreenshot
}))
vi.mock('../../scripts/emulator-developer-menu-dismissal.mjs', () => ({
  dismissEmulatorDeveloperMenuIfPresent: mocks.dismissDeveloperMenu
}))
vi.mock('../../scripts/hosted-ios-emulator-accessibility.mjs', () => ({
  tapHostedIosAccessibilityControl: mocks.tapControl,
  tapHostedIosAccessibilityControlByLabelPrefix: mocks.tapControlByPrefix,
  tapHostedIosPoint: mocks.tapPoint,
  waitForHostedIosAccessibilityControl: mocks.waitForControl,
  waitForHostedIosAccessibilityControlByLabelPrefix: mocks.waitForControlByPrefix,
  waitForHostedIosAccessibilityControlMatch: mocks.waitForControlMatch,
  waitForHostedIosAccessibilityControlMatching: mocks.waitForControlMatching
}))
vi.mock('../../scripts/hosted-ios-screenshot-parity.mjs', () => ({
  assertHostedIosScreenshotParity: mocks.compareScreenshots
}))
vi.mock('../../scripts/hosted-webview-cdp-session.mjs', () => ({
  activateHostedWebViewControl: mocks.activateControl,
  readHostedWebViewTextPoint: mocks.readTextPoint,
  waitForVisibleHostedWebView: mocks.waitForDocument
}))
vi.mock('../../scripts/hosted-webview-control-point.mjs', () => ({
  readHostedWebViewControlPoint: mocks.readControlPoint
}))
vi.mock('../../scripts/hosted-webview-workspace-activation.mjs', () => ({
  activateHostedWorkspaceRow: mocks.activateWorkspace
}))

import {
  captureHostedCoreRouteParity,
  captureNativeCoreRouteBaselines
} from '../../scripts/hosted-ios-core-route-parity.mjs'

describe('hosted iOS core-route parity', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.captureScreenshot.mockImplementation((_command, _args, callback) =>
      callback(null, '', '')
    )
    mocks.compareScreenshots.mockResolvedValue({ changedPixelRatio: 0.01 })
    mocks.readControlPoint.mockResolvedValue({ x: 0.8, y: 0.1 })
    mocks.readTextPoint.mockResolvedValue({ x: 0.2, y: 0.1 })
    mocks.tapControl.mockResolvedValue(undefined)
    mocks.tapControlByPrefix.mockResolvedValue(undefined)
    mocks.tapPoint.mockResolvedValue(undefined)
    mocks.waitForControl.mockResolvedValue({ x: 0.2, y: 0.1 })
    mocks.waitForControlByPrefix.mockResolvedValue({ x: 0.2, y: 0.1 })
    mocks.waitForControlMatch.mockResolvedValue({
      label: 'Connect your Linear account',
      x: 0.5,
      y: 0.5
    })
    mocks.waitForControlMatching.mockResolvedValue({
      label: 'Stable task title, 3m, Issue · orca #1, Open',
      value: '',
      x: 0.5,
      y: 0.5
    })
    mocks.waitForDocument.mockImplementation(({ expectedHrefIncludes }) => ({
      href: `orca-mobile-web://build${expectedHrefIncludes ?? '/h/host'}`
    }))
  })

  it('captures native Tasks and Session from the same presentation source', async () => {
    const baselines = await captureNativeCoreRouteBaselines({
      deviceUdid: 'simulator',
      emulator: { deviceUdid: 'simulator' },
      expectedWorkspace: 'mobile-rearch',
      runtimeDirectory: '/tmp/parity',
      timeoutMs: 30_000
    })

    expect(baselines.tasks.stableText).toBe('Connect your Linear account')
    expect(mocks.tapPoint).toHaveBeenNthCalledWith(
      1,
      { deviceUdid: 'simulator' },
      { x: 0.87, y: 0.1 }
    )
    expect(mocks.tapPoint).toHaveBeenNthCalledWith(
      2,
      { deviceUdid: 'simulator' },
      expect.objectContaining({ y: 0.1 })
    )
    expect(mocks.tapPoint.mock.calls[1][1].x).toBeCloseTo(0.08)
    expect(mocks.tapControl).toHaveBeenCalledWith(
      { deviceUdid: 'simulator' },
      'Back to worktrees',
      30_000
    )
    expect(baselines.session.screenshot).toBe('/tmp/parity/native-session-portrait.png')
  })

  it('captures a populated GitHub Tasks list after pagination appears', async () => {
    mocks.waitForControlMatch.mockRejectedValueOnce(new Error('no empty state'))

    const baselines = await captureNativeCoreRouteBaselines({
      deviceUdid: 'simulator',
      emulator: { deviceUdid: 'simulator' },
      expectedWorkspace: 'mobile-rearch',
      runtimeDirectory: '/tmp/parity',
      timeoutMs: 30_000
    })

    expect(mocks.waitForControlMatch).toHaveBeenCalledWith(
      { deviceUdid: 'simulator' },
      expect.any(Array),
      5_000
    )
    expect(mocks.waitForControlMatching).toHaveBeenCalledWith(
      { deviceUdid: 'simulator' },
      expect.any(Function),
      25_000
    )
    expect(baselines.tasks.stableText).toBe('Stable task title')
  })

  it('compares hosted Tasks and Session and returns to the workspace route', async () => {
    const nativeBaselines = {
      tasks: {
        screenTitlePoint: { x: 0.2, y: 0.1 },
        screenshot: '/tmp/parity/native-tasks-portrait.png',
        stableText: 'Connect your Linear account'
      },
      session: {
        screenTitlePoint: { x: 0.2, y: 0.1 },
        screenshot: '/tmp/parity/native-session-portrait.png'
      }
    }

    const result = await captureHostedCoreRouteParity({
      deviceUdid: 'simulator',
      discoveryUrl: 'http://127.0.0.1:9222',
      emulator: { deviceUdid: 'simulator' },
      expectedWorkspace: 'mobile-rearch',
      nativeBaselines,
      runtimeDirectory: '/tmp/parity',
      timeoutMs: 30_000,
      workspaceDocument: { href: 'orca-mobile-web://build/h/host' }
    })

    expect(result.evidence.tasks.screenshotParity).toEqual({
      changedPixelRatio: 0.01
    })
    expect(result.evidence.session.screenshotParity).toEqual({
      changedPixelRatio: 0.01
    })
    expect(result.workspaceDocument.href).toContain('/h/host')
    expect(mocks.activateWorkspace).toHaveBeenCalledWith(
      expect.anything(),
      'mobile-rearch',
      mocks.activateControl,
      30_000,
      expect.any(Function)
    )
    expect(mocks.readTextPoint).toHaveBeenCalledWith(expect.anything(), 'Filter')
    expect(mocks.tapControl).toHaveBeenCalledWith(
      { deviceUdid: 'simulator' },
      'Back to worktrees',
      5_000
    )
    expect(mocks.compareScreenshots).toHaveBeenCalledTimes(2)
  })

  it('uses a measured point when the hosted session back control is missing from AX', async () => {
    mocks.tapControl.mockRejectedValueOnce(new Error('missing accessibility descendant'))

    await captureHostedCoreRouteParity({
      deviceUdid: 'simulator',
      discoveryUrl: 'http://127.0.0.1:9222',
      emulator: { deviceUdid: 'simulator' },
      expectedWorkspace: 'mobile-rearch',
      nativeBaselines: {
        tasks: {
          screenTitlePoint: { x: 0.2, y: 0.1 },
          screenshot: '/tmp/parity/native-tasks-portrait.png',
          stableText: 'Connect your Linear account'
        },
        session: {
          screenTitlePoint: { x: 0.2, y: 0.1 },
          screenshot: '/tmp/parity/native-session-portrait.png'
        }
      },
      runtimeDirectory: '/tmp/parity',
      timeoutMs: 30_000,
      workspaceDocument: { href: 'orca-mobile-web://build/h/host' }
    })

    expect(mocks.readControlPoint).toHaveBeenCalledWith(expect.anything(), 'Back to worktrees')
    expect(mocks.tapPoint).toHaveBeenCalledWith({ deviceUdid: 'simulator' }, { x: 0.8, y: 0.1 })
  })
})
