import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  activateControl: vi.fn(),
  activateWorkspace: vi.fn(),
  captureScreenshot: vi.fn(),
  compareScreenshots: vi.fn(),
  dismissDeveloperMenu: vi.fn(),
  readControlPoint: vi.fn(),
  readState: vi.fn(),
  readTextPoint: vi.fn(),
  tapControl: vi.fn(),
  tapControlByPrefix: vi.fn(),
  tapPoint: vi.fn(),
  waitForControl: vi.fn(),
  waitForControlByPrefix: vi.fn(),
  waitForLabel: vi.fn(),
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
  waitForHostedIosAccessibilityLabel: mocks.waitForLabel
}))
vi.mock('../../scripts/hosted-ios-screenshot-parity.mjs', () => ({
  assertHostedIosScreenshotParity: mocks.compareScreenshots
}))
vi.mock('../../scripts/hosted-webview-cdp-session.mjs', () => ({
  activateHostedWebViewControl: mocks.activateControl,
  readHostedWebViewState: mocks.readState,
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
  captureHostedFilesPreviewParity,
  captureNativeFilesPreviewBaselines
} from '../../scripts/hosted-ios-files-preview-parity.mjs'

describe('hosted iOS Files and Preview parity', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.captureScreenshot.mockImplementation((_command, _args, callback) =>
      callback(null, '', '')
    )
    mocks.compareScreenshots.mockResolvedValue({ changedPixelRatio: 0.01 })
    mocks.readControlPoint.mockResolvedValue({ x: 0.8, y: 0.1 })
    mocks.readState.mockResolvedValue({
      href: 'orca-mobile-web://build/h/host/files/worktree',
      bodyText: 'Files Casks orca.rb',
      labels: ['Open folder Casks', 'Preview file orca.rb', 'File preview'],
      placeholders: []
    })
    mocks.readTextPoint.mockResolvedValue({ x: 0.2, y: 0.1 })
    mocks.tapControl.mockResolvedValue(undefined)
    mocks.tapControlByPrefix.mockResolvedValue(undefined)
    mocks.tapPoint.mockResolvedValue(undefined)
    mocks.waitForControl.mockResolvedValue({ x: 0.2, y: 0.1 })
    mocks.waitForControlByPrefix.mockResolvedValue({ x: 0.2, y: 0.1 })
    mocks.waitForLabel.mockResolvedValue({
      frame: { x: 0, y: 0.3, width: 1, height: 1.5 },
      label: 'File preview',
      value: ''
    })
    mocks.waitForDocument.mockImplementation(({ expectedHrefIncludes }) => ({
      href: `orca-mobile-web://build${expectedHrefIncludes ?? '/h/host'}`,
      targetId: expectedHrefIncludes ?? 'workspace'
    }))
  })

  it('captures native Files and Preview and returns to worktrees', async () => {
    const baselines = await captureNativeFilesPreviewBaselines({
      deviceUdid: 'simulator',
      emulator: { deviceUdid: 'simulator' },
      expectedWorkspace: 'mobile-rearch',
      runtimeDirectory: '/tmp/parity',
      timeoutMs: 30_000
    })

    expect(mocks.tapControl).toHaveBeenCalledWith(
      { deviceUdid: 'simulator' },
      'Open file explorer',
      30_000
    )
    expect(mocks.tapControl).toHaveBeenCalledWith(
      { deviceUdid: 'simulator' },
      'Preview file orca.rb',
      30_000
    )
    expect(mocks.tapControl).toHaveBeenCalledWith(
      { deviceUdid: 'simulator' },
      'Back to worktrees',
      30_000
    )
    expect(baselines).toEqual({
      files: {
        screenTitlePoint: { x: 0.2, y: 0.1 },
        screenshot: '/tmp/parity/native-files-portrait.png'
      },
      preview: {
        screenTitlePoint: { x: 0.2, y: 0.1 },
        screenshot: '/tmp/parity/native-file-preview-portrait.png'
      }
    })
  })

  it('compares hosted Files and Preview and returns to the workspace route', async () => {
    const result = await captureHostedFilesPreviewParity({
      deviceUdid: 'simulator',
      discoveryUrl: 'http://127.0.0.1:9222',
      emulator: { deviceUdid: 'simulator' },
      expectedWorkspace: 'mobile-rearch',
      nativeBaselines: {
        files: {
          screenTitlePoint: { x: 0.2, y: 0.1 },
          screenshot: '/tmp/parity/native-files-portrait.png'
        },
        preview: {
          screenTitlePoint: { x: 0.2, y: 0.1 },
          screenshot: '/tmp/parity/native-file-preview-portrait.png'
        }
      },
      runtimeDirectory: '/tmp/parity',
      timeoutMs: 30_000,
      workspaceDocument: { href: 'orca-mobile-web://build/h/host' }
    })

    expect(result.evidence.files.screenshotParity).toEqual({ changedPixelRatio: 0.01 })
    expect(result.evidence.preview.screenshotParity).toEqual({ changedPixelRatio: 0.01 })
    expect(result.workspaceDocument.href).toContain('/h/host')
    expect(mocks.activateWorkspace).toHaveBeenCalledOnce()
    expect(mocks.tapControl).toHaveBeenCalledWith(
      { deviceUdid: 'simulator' },
      'Open file explorer',
      5_000
    )
    expect(mocks.tapControl).toHaveBeenCalledWith(
      { deviceUdid: 'simulator' },
      'Preview file orca.rb',
      5_000
    )
    expect(mocks.compareScreenshots).toHaveBeenCalledTimes(2)
  })

  it('uses a measured WebView point when a control is missing from native accessibility', async () => {
    mocks.tapControl.mockRejectedValueOnce(new Error('missing accessibility descendant'))

    await captureHostedFilesPreviewParity({
      deviceUdid: 'simulator',
      discoveryUrl: 'http://127.0.0.1:9222',
      emulator: { deviceUdid: 'simulator' },
      expectedWorkspace: 'mobile-rearch',
      nativeBaselines: {
        files: {
          screenTitlePoint: { x: 0.2, y: 0.1 },
          screenshot: '/tmp/parity/native-files-portrait.png'
        },
        preview: {
          screenTitlePoint: { x: 0.2, y: 0.1 },
          screenshot: '/tmp/parity/native-file-preview-portrait.png'
        }
      },
      runtimeDirectory: '/tmp/parity',
      timeoutMs: 30_000,
      workspaceDocument: { href: 'orca-mobile-web://build/h/host' }
    })

    expect(mocks.readControlPoint).toHaveBeenCalledWith(expect.anything(), 'Open file explorer')
    expect(mocks.tapPoint).toHaveBeenCalledWith({ deviceUdid: 'simulator' }, { x: 0.8, y: 0.1 })
  })
})
