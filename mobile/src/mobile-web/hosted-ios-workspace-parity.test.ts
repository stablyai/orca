import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  captureScreenshot: vi.fn(),
  compareScreenshots: vi.fn(),
  dismissDeveloperMenu: vi.fn(),
  readTextPoint: vi.fn(),
  waitForControl: vi.fn()
}))

vi.mock('node:child_process', () => ({
  execFile: mocks.captureScreenshot
}))
vi.mock('../../scripts/emulator-developer-menu-dismissal.mjs', () => ({
  dismissEmulatorDeveloperMenuIfPresent: mocks.dismissDeveloperMenu
}))
vi.mock('../../scripts/hosted-ios-emulator-accessibility.mjs', () => ({
  waitForHostedIosAccessibilityControl: mocks.waitForControl
}))
vi.mock('../../scripts/hosted-ios-screenshot-parity.mjs', () => ({
  assertHostedIosScreenshotParity: mocks.compareScreenshots
}))
vi.mock('../../scripts/hosted-webview-cdp-session.mjs', () => ({
  readHostedWebViewTextPoint: mocks.readTextPoint
}))

import {
  captureHostedWorkspaceParity,
  captureNativeWorkspaceBaseline
} from '../../scripts/hosted-ios-workspace-parity.mjs'

describe('hosted iOS workspace parity', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.captureScreenshot.mockImplementation((_command, _args, callback) =>
      callback(null, '', '')
    )
    mocks.compareScreenshots.mockResolvedValue({ changedPixelRatio: 0.01 })
    mocks.readTextPoint.mockResolvedValue({ x: 0.2, y: 0.1 })
    mocks.waitForControl.mockResolvedValue({ x: 0.2, y: 0.1 })
  })

  it('captures the unchanged native workspace screen', async () => {
    const baseline = await captureNativeWorkspaceBaseline({
      deviceUdid: 'simulator',
      emulator: { deviceUdid: 'simulator' },
      runtimeDirectory: '/tmp/parity',
      timeoutMs: 30_000
    })

    expect(mocks.waitForControl).toHaveBeenCalledWith({ deviceUdid: 'simulator' }, 'Filter', 30_000)
    expect(baseline).toEqual({
      filterPoint: { x: 0.2, y: 0.1 },
      screenshot: '/tmp/parity/native-workspace-portrait.png'
    })
  })

  it('compares the unchanged hosted workspace screen', async () => {
    const evidence = await captureHostedWorkspaceParity({
      deviceUdid: 'simulator',
      document: { href: 'orca-mobile-web://build/h/host' },
      nativeBaseline: {
        filterPoint: { x: 0.2, y: 0.1 },
        screenshot: '/tmp/parity/native-workspace-portrait.png'
      },
      runtimeDirectory: '/tmp/parity',
      timeoutMs: 30_000
    })

    expect(mocks.readTextPoint).toHaveBeenCalledWith(expect.anything(), 'Filter')
    expect(mocks.compareScreenshots).toHaveBeenCalledOnce()
    expect(evidence).toEqual({
      nativeScreenshot: 'native-workspace-portrait.png',
      hostedScreenshot: 'hosted-workspace-portrait.png',
      nativeFilterPoint: { x: 0.2, y: 0.1 },
      hostedFilterPoint: { x: 0.2, y: 0.1 },
      screenshotParity: { changedPixelRatio: 0.01 }
    })
  })
})
