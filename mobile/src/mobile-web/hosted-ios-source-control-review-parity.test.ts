import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  captureScreenshot: vi.fn(),
  compareScreenshots: vi.fn(),
  dismissDeveloperMenu: vi.fn(),
  longPressControlByPrefix: vi.fn(),
  readLabels: vi.fn(),
  readTextPoint: vi.fn(),
  tapControl: vi.fn(),
  tapControlByPrefix: vi.fn(),
  waitForControl: vi.fn(),
  waitForControlByPrefix: vi.fn(),
  waitForControlEndingWith: vi.fn(),
  waitForControlMatching: vi.fn()
}))

vi.mock('node:child_process', () => ({
  execFile: mocks.captureScreenshot
}))
vi.mock('../../scripts/emulator-developer-menu-dismissal.mjs', () => ({
  dismissEmulatorDeveloperMenuIfPresent: mocks.dismissDeveloperMenu
}))
vi.mock('../../scripts/hosted-ios-emulator-accessibility.mjs', () => ({
  readHostedIosAccessibilityLabels: mocks.readLabels,
  tapHostedIosAccessibilityControl: mocks.tapControl,
  tapHostedIosAccessibilityControlByLabelPrefix: mocks.tapControlByPrefix,
  waitForHostedIosAccessibilityControl: mocks.waitForControl,
  waitForHostedIosAccessibilityControlByLabelPrefix: mocks.waitForControlByPrefix,
  waitForHostedIosAccessibilityControlEndingWith: mocks.waitForControlEndingWith,
  waitForHostedIosAccessibilityControlMatching: mocks.waitForControlMatching
}))
vi.mock('../../scripts/hosted-ios-emulator-long-press.mjs', () => ({
  longPressHostedIosAccessibilityControlByLabelPrefix: mocks.longPressControlByPrefix
}))
vi.mock('../../scripts/hosted-ios-screenshot-parity.mjs', () => ({
  assertHostedIosScreenshotParity: mocks.compareScreenshots
}))
vi.mock('../../scripts/hosted-webview-cdp-session.mjs', () => ({
  readHostedWebViewTextPoint: mocks.readTextPoint
}))

import {
  captureHostedSourceControlReviewScreen,
  captureNativeSourceControlReviewBaselines,
  HEADLESS_REVIEW_OPEN_ERROR
} from '../../scripts/hosted-ios-source-control-review-parity.mjs'

describe('hosted iOS Source Control and Review parity', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.captureScreenshot.mockImplementation((_command, _args, callback) =>
      callback(null, '', '')
    )
    mocks.compareScreenshots.mockResolvedValue({ changedPixelRatio: 0.01 })
    mocks.longPressControlByPrefix.mockResolvedValue({ x: 0.5, y: 0.4 })
    mocks.readLabels.mockResolvedValue([
      'Open source control',
      'Source Control',
      'Back to session',
      HEADLESS_REVIEW_OPEN_ERROR
    ])
    mocks.readTextPoint.mockResolvedValue({ x: 0.2, y: 0.1 })
    mocks.tapControl.mockResolvedValue({ x: 0.2, y: 0.1 })
    mocks.tapControlByPrefix.mockResolvedValue({ x: 0.5, y: 0.4 })
    mocks.waitForControl.mockResolvedValue({ x: 0.2, y: 0.1 })
    mocks.waitForControlByPrefix.mockResolvedValue({ x: 0.5, y: 0.4 })
    mocks.waitForControlEndingWith.mockResolvedValue({ x: 0.5, y: 0.4 })
    mocks.waitForControlMatching
      .mockResolvedValueOnce({
        label: 'Open changed file mobile/app/index.tsx',
        value: '',
        x: 0.5,
        y: 0.5
      })
      .mockResolvedValueOnce({
        label: 'Pull request #13386, Draft, No checks. Open pull request.',
        value: '',
        x: 0.5,
        y: 0.3
      })
      .mockResolvedValue({
        label: 'Open changed file mobile/app/index.tsx',
        value: '',
        x: 0.5,
        y: 0.5
      })
  })

  it('captures the real host-origin Source Control and standalone Review path', async () => {
    const baselines = await captureNativeSourceControlReviewBaselines({
      deviceUdid: 'simulator',
      emulator: { deviceUdid: 'simulator' },
      expectedWorkspace: 'mobile-rearch',
      runtimeDirectory: '/tmp/parity',
      timeoutMs: 30_000
    })

    expect(mocks.longPressControlByPrefix).toHaveBeenCalledWith(
      { deviceUdid: 'simulator' },
      'mobile-rearch',
      30_000,
      undefined,
      'Source Control'
    )
    expect(mocks.tapControl).toHaveBeenCalledWith(
      { deviceUdid: 'simulator' },
      'Source Control',
      30_000
    )
    expect(mocks.tapControl).toHaveBeenCalledWith(
      { deviceUdid: 'simulator' },
      'Open changed file mobile/app/index.tsx',
      30_000
    )
    expect(baselines).toEqual({
      review: {
        screenTitlePoint: { x: 0.2, y: 0.1 },
        screenshot: '/tmp/parity/native-review-portrait.png'
      },
      // Why: the session-origin probe records what the paired host answers, so the
      // hosted journey can assert parity instead of asserting a failure.
      sessionOriginReviewOpen: {
        changedFileLabel: 'Open changed file mobile/app/index.tsx',
        headless: HEADLESS_REVIEW_OPEN_ERROR
      },
      sourceControl: {
        changedFileLabel: 'Open changed file mobile/app/index.tsx',
        pullRequestState: {
          kind: 'ready',
          label: 'Pull request #13386, Draft, No checks. Open pull request.',
          number: '13386'
        },
        screenTitlePoint: { x: 0.2, y: 0.1 },
        screenshot: '/tmp/parity/native-source-control-portrait.png'
      }
    })
  })

  it('uses value-backed accessibility text for the changed file and pull request', async () => {
    mocks.waitForControlMatching
      .mockReset()
      .mockResolvedValue({
        label: 'Changed file',
        value: 'Open changed file mobile/src/mobile-web/bridge.ts',
        x: 0.5,
        y: 0.5
      })
      .mockResolvedValueOnce({
        label: 'Changed file',
        value: 'Open changed file mobile/src/mobile-web/bridge.ts',
        x: 0.5,
        y: 0.5
      })
      .mockResolvedValueOnce({
        label: '',
        value: 'Pull request #13386, Draft, No checks. Open pull request.',
        x: 0.5,
        y: 0.3
      })

    const baselines = await captureNativeSourceControlReviewBaselines({
      deviceUdid: 'simulator',
      emulator: { deviceUdid: 'simulator' },
      expectedWorkspace: 'mobile-rearch',
      runtimeDirectory: '/tmp/parity',
      timeoutMs: 30_000
    })

    expect(baselines.sourceControl).toMatchObject({
      changedFileLabel: 'Open changed file mobile/src/mobile-web/bridge.ts',
      pullRequestState: { kind: 'ready', number: '13386' }
    })
    expect(mocks.tapControl).toHaveBeenCalledWith(
      { deviceUdid: 'simulator' },
      'Open changed file mobile/src/mobile-web/bridge.ts',
      30_000
    )
  })

  it('compares a hosted route against its native screenshot and title landmark', async () => {
    const capture = await captureHostedSourceControlReviewScreen({
      deviceUdid: 'simulator',
      document: { href: 'orca-mobile-web://build/h/host/review/worktree' },
      nativeBaseline: {
        screenTitlePoint: { x: 0.2, y: 0.1 },
        screenshot: '/tmp/parity/native-review-portrait.png'
      },
      runtimeDirectory: '/tmp/parity',
      screenshotName: 'hosted-review-portrait.png',
      title: 'Changes',
      timeoutMs: 30_000
    })

    expect(capture.screenshotParity).toEqual({ changedPixelRatio: 0.01 })
    expect(mocks.compareScreenshots).toHaveBeenCalledWith({
      hostedLandmark: { x: 0.2, y: 0.1 },
      hostedScreenshot: '/tmp/parity/hosted-review-portrait.png',
      nativeLandmark: { x: 0.2, y: 0.1 },
      nativeScreenshot: '/tmp/parity/native-review-portrait.png'
    })
  })
})
