import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  captureParityScreen: vi.fn(),
  readBridgeErrors: vi.fn(),
  navigateRoute: vi.fn(),
  parityEvidence: vi.fn(),
  readControlPoint: vi.fn(),
  readState: vi.fn(),
  tapAccessibilityControl: vi.fn(),
  tapPoint: vi.fn(),
  startBridgeErrorObservation: vi.fn(),
  waitForDocument: vi.fn()
}))

vi.mock('../../scripts/hosted-webview-cdp-session.mjs', () => ({
  readHostedWebViewState: mocks.readState,
  waitForVisibleHostedWebView: mocks.waitForDocument
}))

vi.mock('../../scripts/hosted-webview-control-point.mjs', () => ({
  readHostedWebViewControlPoint: mocks.readControlPoint
}))

vi.mock('../../scripts/hosted-ios-emulator-accessibility.mjs', () => ({
  tapHostedIosAccessibilityControl: mocks.tapAccessibilityControl,
  tapHostedIosPoint: mocks.tapPoint
}))

vi.mock('../../scripts/hosted-webview-route-navigation.mjs', () => ({
  navigateHostedWebViewRoute: mocks.navigateRoute
}))

vi.mock('../../scripts/hosted-webview-bridge-error-observation.mjs', () => ({
  readHostedWebViewBridgeErrors: mocks.readBridgeErrors,
  startHostedWebViewBridgeErrorObservation: mocks.startBridgeErrorObservation
}))

vi.mock('../../scripts/hosted-ios-source-control-review-parity.mjs', () => ({
  captureHostedSourceControlReviewScreen: mocks.captureParityScreen,
  HEADLESS_REVIEW_OPEN_ERROR: 'renderer_unavailable',
  sourceControlReviewParityEvidence: mocks.parityEvidence
}))

import { verifyHostedSourceControlReviewJourney } from '../../scripts/hosted-ios-source-control-review-journey.mjs'

describe('hosted iOS Source Control and Review journey', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.readControlPoint
      .mockResolvedValueOnce({ x: 0.4, y: 0.2 })
      .mockResolvedValueOnce({ x: 0.5, y: 0.4 })
    mocks.navigateRoute.mockResolvedValue(undefined)
    mocks.captureParityScreen
      .mockResolvedValueOnce({ screenshot: '/tmp/hosted-source-control.png' })
      .mockResolvedValueOnce({ screenshot: '/tmp/hosted-review.png' })
    mocks.parityEvidence
      .mockReturnValueOnce({ screen: 'source-control' })
      .mockReturnValueOnce({ screen: 'review' })
    mocks.tapAccessibilityControl.mockResolvedValue(undefined)
    mocks.tapPoint.mockResolvedValue(undefined)
    mocks.startBridgeErrorObservation.mockResolvedValue(undefined)
    mocks.readBridgeErrors.mockResolvedValue([])
    mocks.waitForDocument
      .mockResolvedValueOnce({
        href: 'orca-mobile-web://build/h/host/source-control/workspace'
      })
      .mockResolvedValueOnce({
        href: 'orca-mobile-web://build/h/host/session/workspace'
      })
      .mockResolvedValueOnce({
        href: 'orca-mobile-web://build/h/host/review/workspace'
      })
    mocks.readState
      .mockResolvedValueOnce({
        href: 'orca-mobile-web://build/h/host/source-control/workspace',
        bodyText: 'Source Control Changes Pull Request Commits Create pull request 128 on branch',
        labels: ['Refresh source control', 'Open changed file mobile/app/index.tsx']
      })
      .mockResolvedValueOnce({
        href: 'orca-mobile-web://build/h/host/review/workspace',
        bodyText: 'reviewed',
        labels: ['Back', 'Open review actions']
      })
  })

  it('opens the unchanged Session diff flow and standalone Review route', async () => {
    const emulator = { deviceUdid: 'simulator' }
    const sessionDocument = {
      href: 'orca-mobile-web://build/h/host/session/workspace'
    }

    await expect(
      verifyHostedSourceControlReviewJourney({
        discoveryUrl: 'http://127.0.0.1:9222',
        emulator,
        sessionDocument,
        timeoutMs: 30_000
      })
    ).resolves.toEqual({
      sourceControlRoute: 'orca-mobile-web://build/h/host/source-control/workspace',
      sourceControlSegments: ['Changes', 'Pull Request', 'Commits'],
      sessionDiffRoute: 'orca-mobile-web://build/h/host/session/workspace',
      reviewOpen: { headless: false, native: null },
      reviewRoute: 'orca-mobile-web://build/h/host/review/workspace',
      reviewControls: ['Back', 'Open review actions']
    })

    expect(mocks.readControlPoint).toHaveBeenNthCalledWith(
      1,
      sessionDocument,
      'Open source control'
    )
    expect(mocks.tapAccessibilityControl).toHaveBeenNthCalledWith(
      1,
      emulator,
      'Open source control',
      5_000
    )
    expect(mocks.tapAccessibilityControl).toHaveBeenNthCalledWith(
      2,
      emulator,
      'Open changed file mobile/app/index.tsx',
      5_000
    )
    expect(mocks.tapPoint).not.toHaveBeenCalled()
    expect(mocks.navigateRoute).toHaveBeenCalledWith(
      { href: 'orca-mobile-web://build/h/host/session/workspace' },
      '/h/host/review/workspace?scope=all'
    )
  })

  it('accepts a platform-specific native tap implementation', async () => {
    const tapPoint = vi.fn().mockResolvedValue(undefined)
    const inspectChangedContent = vi.fn().mockResolvedValue(undefined)

    await verifyHostedSourceControlReviewJourney({
      discoveryUrl: 'http://127.0.0.1:9222',
      emulator: { adb: '/sdk/adb' },
      sessionDocument: {
        href: 'orca-mobile-web://build/h/host/session/workspace'
      },
      expectedSessionDiffText: '3 tabs',
      inspectChangedContent,
      timeoutMs: 30_000,
      tapPoint
    })

    expect(tapPoint).toHaveBeenCalledTimes(2)
    expect(tapPoint.mock.calls.map((call) => call[2])).toEqual([
      'Open source control',
      'Open changed file mobile/app/index.tsx'
    ])
    expect(inspectChangedContent.mock.calls.map((call) => call[0].phase)).toEqual([
      'sourceControl',
      'sessionDiff',
      'review'
    ])
    expect(mocks.waitForDocument).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ expectedText: '3 tabs' })
    )
  })

  it('captures strict Source Control and Review parity when native baselines are provided', async () => {
    const result = await verifyHostedSourceControlReviewJourney({
      deviceUdid: 'simulator',
      discoveryUrl: 'http://127.0.0.1:9222',
      emulator: { deviceUdid: 'simulator' },
      nativeBaselines: {
        sourceControl: {
          changedFileLabel: 'Open changed file mobile/app/index.tsx',
          pullRequestState: {
            kind: 'create',
            label: 'Create pull request'
          },
          screenshot: '/tmp/native-source-control.png'
        },
        review: { screenshot: '/tmp/native-review.png' }
      },
      runtimeDirectory: '/tmp/parity',
      sessionDocument: {
        href: 'orca-mobile-web://build/h/host/session/workspace'
      },
      timeoutMs: 30_000
    })

    expect(mocks.captureParityScreen).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        deviceUdid: 'simulator',
        screenshotName: 'hosted-source-control-portrait.png',
        title: 'Source Control'
      })
    )
    expect(mocks.captureParityScreen).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        deviceUdid: 'simulator',
        screenshotName: 'hosted-review-portrait.png',
        title: 'Changes'
      })
    )
    expect(result.parityFixture).toEqual({
      sourceControl: { screen: 'source-control' },
      review: { screen: 'review' }
    })
  })

  it('settles parity against the existing pull request captured by native', async () => {
    const pullRequestLabel = 'Pull request #13386, Draft, No checks. Open pull request.'
    mocks.readState
      .mockReset()
      .mockResolvedValueOnce({
        href: 'orca-mobile-web://build/h/host/source-control/workspace',
        bodyText: 'Source Control Changes Pull Request Commits #13386 Draft 128 on branch',
        labels: [
          'Refresh source control',
          pullRequestLabel,
          'Open changed file mobile/app/index.tsx'
        ]
      })
      .mockResolvedValueOnce({
        href: 'orca-mobile-web://build/h/host/review/workspace',
        bodyText: 'reviewed',
        labels: ['Back', 'Open review actions']
      })

    await expect(
      verifyHostedSourceControlReviewJourney({
        deviceUdid: 'simulator',
        discoveryUrl: 'http://127.0.0.1:9222',
        emulator: { deviceUdid: 'simulator' },
        nativeBaselines: {
          sourceControl: {
            changedFileLabel: 'Open changed file mobile/app/index.tsx',
            pullRequestState: { kind: 'ready', label: pullRequestLabel, number: '13386' },
            screenshot: '/tmp/native-source-control.png'
          },
          review: { screenshot: '/tmp/native-review.png' }
        },
        runtimeDirectory: '/tmp/parity',
        sessionDocument: {
          href: 'orca-mobile-web://build/h/host/session/workspace'
        },
        timeoutMs: 30_000
      })
    ).resolves.toMatchObject({ sourceControlSegments: ['Changes', 'Pull Request', 'Commits'] })
  })

  it('opens the exact changed file captured by the native baseline', async () => {
    const nativeChangedFileLabel = 'Open changed file mobile/src/mobile-web/bridge.ts'
    mocks.readState
      .mockReset()
      .mockResolvedValueOnce({
        href: 'orca-mobile-web://build/h/host/source-control/workspace',
        bodyText: 'Source Control Changes Pull Request Commits Create pull request 128 on branch',
        labels: [
          'Refresh source control',
          'Open changed file mobile/app/index.tsx',
          nativeChangedFileLabel
        ]
      })
      .mockResolvedValueOnce({
        href: 'orca-mobile-web://build/h/host/review/workspace',
        bodyText: 'reviewed',
        labels: ['Back', 'Open review actions']
      })

    await verifyHostedSourceControlReviewJourney({
      deviceUdid: 'simulator',
      discoveryUrl: 'http://127.0.0.1:9222',
      emulator: { deviceUdid: 'simulator' },
      nativeBaselines: {
        sourceControl: {
          changedFileLabel: nativeChangedFileLabel,
          pullRequestState: { kind: 'create', label: 'Create pull request' },
          screenshot: '/tmp/native-source-control.png'
        },
        review: { screenshot: '/tmp/native-review.png' }
      },
      runtimeDirectory: '/tmp/parity',
      sessionDocument: { href: 'orca-mobile-web://build/h/host/session/workspace' },
      timeoutMs: 30_000
    })

    expect(mocks.tapAccessibilityControl).toHaveBeenNthCalledWith(
      2,
      { deviceUdid: 'simulator' },
      nativeChangedFileLabel,
      5_000
    )
  })

  it('falls back to measured points when WebKit omits accessibility descendants', async () => {
    mocks.tapAccessibilityControl.mockRejectedValue(new Error('missing descendant'))

    await verifyHostedSourceControlReviewJourney({
      discoveryUrl: 'http://127.0.0.1:9222',
      emulator: { deviceUdid: 'simulator' },
      sessionDocument: {
        href: 'orca-mobile-web://build/h/host/session/workspace'
      },
      timeoutMs: 30_000
    })

    expect(mocks.tapPoint).toHaveBeenNthCalledWith(1, expect.anything(), {
      x: 0.4,
      y: 0.2
    })
    expect(mocks.tapPoint).toHaveBeenNthCalledWith(2, expect.anything(), {
      x: 0.5,
      y: 0.4
    })
  })

  it('uses measured native taps for duplicated Source Control segment labels', async () => {
    const sourceState = {
      href: 'orca-mobile-web://build/h/host/source-control/workspace',
      bodyText: 'Source Control Changes Pull Request Commits Create pull request 128 on branch',
      labels: ['Refresh source control', 'Open changed file mobile/app/index.tsx']
    }
    mocks.readControlPoint
      .mockReset()
      .mockResolvedValueOnce({ x: 0.4, y: 0.2 })
      .mockResolvedValueOnce({ x: 0.6, y: 0.3 })
      .mockResolvedValueOnce({ x: 0.3, y: 0.3 })
      .mockResolvedValueOnce({ x: 0.5, y: 0.4 })
    mocks.readState
      .mockReset()
      .mockResolvedValueOnce(sourceState)
      .mockResolvedValueOnce(sourceState)
      .mockResolvedValueOnce({
        href: 'orca-mobile-web://build/h/host/review/workspace',
        bodyText: 'reviewed',
        labels: ['Back', 'Open review actions']
      })

    await verifyHostedSourceControlReviewJourney({
      discoveryUrl: 'http://127.0.0.1:9222',
      emulator: { deviceUdid: 'simulator' },
      inspectProviderContent: vi.fn().mockResolvedValue(undefined),
      sessionDocument: {
        href: 'orca-mobile-web://build/h/host/session/workspace'
      },
      timeoutMs: 30_000
    })

    expect(mocks.tapPoint).toHaveBeenNthCalledWith(1, expect.anything(), {
      x: 0.6,
      y: 0.3
    })
    expect(mocks.tapPoint).toHaveBeenNthCalledWith(2, expect.anything(), {
      x: 0.3,
      y: 0.3
    })
  })

  it('transforms only the measured fallback while retaining semantic activation', async () => {
    const transformPoint = vi.fn((point) => ({ ...point, y: point.y + 0.1 }))
    mocks.tapAccessibilityControl.mockRejectedValue(new Error('missing descendant'))

    await verifyHostedSourceControlReviewJourney({
      discoveryUrl: 'http://127.0.0.1:9222',
      emulator: { deviceUdid: 'simulator' },
      sessionDocument: {
        href: 'orca-mobile-web://build/h/host/session/workspace'
      },
      timeoutMs: 30_000,
      transformPoint
    })

    expect(mocks.tapAccessibilityControl).toHaveBeenCalledTimes(2)
    expect(mocks.tapPoint.mock.calls[0][1]).toMatchObject({ x: 0.4 })
    expect(mocks.tapPoint.mock.calls[0][1].y).toBeCloseTo(0.3)
    expect(mocks.tapPoint.mock.calls[1][1]).toEqual({ x: 0.5, y: 0.5 })
  })

  it('falls back to a measured point when an accessibility tap silently misses', async () => {
    mocks.readControlPoint
      .mockReset()
      .mockResolvedValueOnce({ x: 0.4, y: 0.2 })
      .mockResolvedValueOnce({ x: 0.5, y: 0.4 })
      .mockResolvedValueOnce({ x: 0.5, y: 0.4 })
    mocks.waitForDocument
      .mockReset()
      .mockResolvedValueOnce({
        href: 'orca-mobile-web://build/h/host/source-control/workspace'
      })
      .mockRejectedValueOnce(new Error('route unchanged'))
      .mockRejectedValueOnce(new Error('route unchanged'))
      .mockResolvedValueOnce({
        href: 'orca-mobile-web://build/h/host/session/workspace'
      })
      .mockResolvedValueOnce({
        href: 'orca-mobile-web://build/h/host/review/workspace'
      })

    await verifyHostedSourceControlReviewJourney({
      discoveryUrl: 'http://127.0.0.1:9222',
      emulator: { deviceUdid: 'simulator' },
      sessionDocument: {
        href: 'orca-mobile-web://build/h/host/session/workspace'
      },
      timeoutMs: 30_000
    })

    expect(mocks.tapAccessibilityControl).toHaveBeenCalledTimes(2)
    expect(mocks.tapPoint).toHaveBeenCalledWith(expect.anything(), {
      x: 0.5,
      y: 0.4
    })
  })

  it('waits for tab state after the route changes', async () => {
    const sessionDocument = {
      href: 'orca-mobile-web://build/h/host/session/workspace'
    }
    mocks.waitForDocument
      .mockReset()
      .mockResolvedValueOnce({
        href: 'orca-mobile-web://build/h/host/source-control/workspace'
      })
      .mockRejectedValueOnce(new Error('tab count pending'))
      .mockResolvedValueOnce(sessionDocument)
      .mockResolvedValueOnce(sessionDocument)
      .mockResolvedValueOnce({
        href: 'orca-mobile-web://build/h/host/review/workspace'
      })

    await verifyHostedSourceControlReviewJourney({
      discoveryUrl: 'http://127.0.0.1:9222',
      emulator: { deviceUdid: 'simulator' },
      sessionDocument: {
        href: 'orca-mobile-web://build/h/host/session/workspace'
      },
      timeoutMs: 30_000
    })

    expect(mocks.tapAccessibilityControl).toHaveBeenCalledTimes(2)
    expect(mocks.tapPoint).not.toHaveBeenCalled()
    expect(mocks.waitForDocument).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ expectedText: '' })
    )
    expect(mocks.waitForDocument).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({ expectedText: '2 tabs' })
    )
  })
  it('records the headless host outcome when the diff route never opens', async () => {
    // Why: `orca serve --mobile-pairing` registers no renderer, so files.openDiff
    // answers renderer_unavailable. The claim is parity with native on this host.
    mocks.waitForDocument.mockReset()
    mocks.waitForDocument.mockImplementation(({ expectedHrefIncludes }) => {
      if (expectedHrefIncludes === '/session/') {
        return Promise.reject(new Error('Session diff route did not open'))
      }
      return Promise.resolve({
        href: `orca-mobile-web://build/h/host${expectedHrefIncludes ?? '/review/'}workspace`
      })
    })
    mocks.readBridgeErrors.mockResolvedValue([
      { capability: 'sourceControl', operation: 'reviewOpen', code: 'host_error', retryable: true }
    ])
    mocks.readState.mockReset()
    mocks.readState
      .mockResolvedValueOnce({
        href: 'orca-mobile-web://build/h/host/source-control/workspace',
        bodyText: 'Source Control Changes Pull Request Commits Create pull request 128 on branch',
        labels: ['Refresh source control', 'Open changed file mobile/app/index.tsx']
      })
      .mockResolvedValueOnce({
        href: 'orca-mobile-web://build/h/host/source-control/workspace',
        bodyText: 'Source Control\nSource control action failed\nStage All'
      })
      .mockResolvedValueOnce({
        href: 'orca-mobile-web://build/h/host/review/workspace',
        bodyText: 'reviewed',
        labels: ['Back', 'Open review actions']
      })

    const result = await verifyHostedSourceControlReviewJourney({
      discoveryUrl: 'http://127.0.0.1:9222',
      emulator: { deviceUdid: 'simulator' },
      nativeReviewOpen: { headless: 'renderer_unavailable' },
      sessionDocument: { href: 'orca-mobile-web://build/h/host/session/workspace' },
      timeoutMs: 30_000
    })

    expect(result.sessionDiffRoute).toBeNull()
    expect(result.reviewOpen).toEqual({
      headless: 'renderer_unavailable',
      native: 'renderer_unavailable',
      bridgeError: {
        capability: 'sourceControl',
        operation: 'reviewOpen',
        code: 'host_error',
        retryable: true
      },
      visibleMessage: 'Source control action failed'
    })
    // The standalone Review route still opens, from the Source Control document.
    expect(result.reviewRoute).toBe('orca-mobile-web://build/h/host/review/workspace')
  })

  it('fails when the hybrid outcome diverges from what native did on the same host', async () => {
    mocks.waitForDocument.mockReset()
    mocks.waitForDocument.mockImplementation(({ expectedHrefIncludes }) => {
      if (expectedHrefIncludes === '/session/') {
        return Promise.reject(new Error('Session diff route did not open'))
      }
      return Promise.resolve({
        href: `orca-mobile-web://build/h/host${expectedHrefIncludes ?? '/review/'}workspace`
      })
    })
    mocks.readBridgeErrors.mockResolvedValue([
      { capability: 'sourceControl', operation: 'reviewOpen', code: 'host_error', retryable: true }
    ])

    await expect(
      verifyHostedSourceControlReviewJourney({
        discoveryUrl: 'http://127.0.0.1:9222',
        emulator: { deviceUdid: 'simulator' },
        nativeReviewOpen: { headless: false },
        sessionDocument: { href: 'orca-mobile-web://build/h/host/session/workspace' },
        timeoutMs: 30_000
      })
    ).rejects.toThrow('Session-origin reviewOpen diverged')
  })
})
