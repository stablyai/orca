import { describe, expect, it, vi } from 'vitest'
import { verifyHostedHostOriginSourceControlJourney } from '../../scripts/hosted-ios-host-origin-source-control-journey.mjs'

describe('hosted iOS host-origin Source Control journey', () => {
  it('opens mobile Review without mutating the Session route', async () => {
    const sourceControl = {
      href: 'orca-mobile-web://build/h/host/source-control/workspace'
    }
    const review = { href: 'orca-mobile-web://build/h/host/review/workspace' }
    const returnedWorkspace = { href: 'orca-mobile-web://build/' }
    const activate = vi.fn().mockResolvedValue(undefined)
    const longPress = vi.fn().mockResolvedValue(undefined)
    const tapNative = vi.fn().mockResolvedValue(undefined)
    const waitForDocument = vi
      .fn()
      .mockResolvedValueOnce(sourceControl)
      .mockResolvedValueOnce(review)
      .mockResolvedValueOnce(sourceControl)
      .mockResolvedValueOnce(sourceControl)
      .mockResolvedValueOnce(returnedWorkspace)
    const readState = vi
      .fn()
      .mockResolvedValueOnce({
        href: sourceControl.href,
        labels: ['Refresh source control', 'Open changed file mobile/src/mobile-web/bridge.ts']
      })
      .mockResolvedValueOnce({
        href: review.href,
        labels: ['Show all review files']
      })
      .mockResolvedValueOnce({
        href: review.href,
        labels: ['Back', 'Open review actions']
      })

    const result = await verifyHostedHostOriginSourceControlJourney({
      discoveryUrl: 'http://127.0.0.1:9222',
      emulator: { udid: 'SIMULATOR-1' },
      nativeBaseline: {
        changedFileLabel: 'Open changed file mobile/src/mobile-web/bridge.ts'
      },
      timeoutMs: 30_000,
      workspaceName: 'mobile-rearch',
      operations: { activate, longPress, readState, tapNative, waitForDocument }
    })

    expect(longPress).toHaveBeenCalledWith(
      { udid: 'SIMULATOR-1' },
      'mobile-rearch',
      30_000,
      undefined,
      'Source Control'
    )
    expect(tapNative).toHaveBeenCalledWith({ udid: 'SIMULATOR-1' }, 'Source Control', 30_000)
    expect(activate.mock.calls.map((call) => call[1])).toEqual([
      { kind: 'label', value: 'Open changed file mobile/src/mobile-web/bridge.ts' },
      { kind: 'label', value: 'Back' },
      { kind: 'label', value: 'Back to session' }
    ])
    expect(waitForDocument).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ expectedHrefIncludes: '/review/' })
    )
    expect(waitForDocument).toHaveBeenCalledTimes(5)
    expect(result).toMatchObject({
      reviewRoute: review.href,
      sourceControlRoute: sourceControl.href,
      workspaceDocument: returnedWorkspace
    })
  })
})
