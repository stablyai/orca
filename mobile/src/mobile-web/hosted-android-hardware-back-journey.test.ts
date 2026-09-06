import { describe, expect, it, vi } from 'vitest'
import {
  openHostedAndroidHardwareBackNestedRoute,
  sendHostedAndroidHardwareBack,
  waitForHostedAndroidWorkspaceRoot,
  verifyHostedAndroidHardwareBackJourney
} from '../../scripts/hosted-android-hardware-back-journey.mjs'

describe('hosted Android hardware Back journey', () => {
  it('uses the real Android Back key event', async () => {
    const runAdb = vi.fn(async () => '')

    await sendHostedAndroidHardwareBack('/sdk/adb', runAdb)

    expect(runAdb).toHaveBeenCalledWith('/sdk/adb', ['shell', 'input', 'keyevent', 'KEYCODE_BACK'])
  })

  it('opens the nested route through the hosted UI navigation stack', async () => {
    const sessionDocument = { href: 'orca-mobile-web://build/h/host/session/workspace' }
    const actionsDocument = { href: sessionDocument.href }
    const historyDocument = {
      href: 'orca-mobile-web://build/h/host/agent-history/workspace'
    }
    const activate = vi.fn().mockResolvedValue(undefined)
    const settle = vi.fn().mockResolvedValue(undefined)
    const waitForDocument = vi
      .fn()
      .mockResolvedValueOnce(actionsDocument)
      .mockResolvedValueOnce(historyDocument)

    await expect(
      openHostedAndroidHardwareBackNestedRoute(
        {
          discoveryUrl: 'http://127.0.0.1:9222',
          sessionDocument,
          timeoutMs: 30_000
        },
        { activate, settle, waitForDocument }
      )
    ).resolves.toBe(historyDocument)

    expect(activate.mock.calls.map((call) => call[1])).toEqual([
      { kind: 'label', value: 'More session actions' },
      { kind: 'text', value: 'Agent History' }
    ])
    expect(waitForDocument).toHaveBeenLastCalledWith(
      expect.objectContaining({ expectedHrefIncludes: '/agent-history/' })
    )
    expect(settle).toHaveBeenCalledWith(500)
  })

  it('waits for the Session route to leave before accepting the workspace root', async () => {
    const waitForDocument = vi
      .fn()
      .mockResolvedValueOnce({ href: '/session/workspace' })
      .mockResolvedValueOnce({ href: '/session/workspace' })
      .mockResolvedValueOnce({ href: '/' })
    const settle = vi.fn().mockResolvedValue(undefined)

    await expect(
      waitForHostedAndroidWorkspaceRoot({
        discoveryUrl: 'http://127.0.0.1:9222',
        settle,
        timeoutMs: 30_000,
        waitForDocument,
        workspaceMarker: 'MOBILE-REARCH'
      })
    ).resolves.toEqual({ href: '/' })

    expect(settle).toHaveBeenCalledTimes(2)
  })

  it('returns through Session and workspace root before dismissing to native home', async () => {
    const events: string[] = []
    const pressBack = vi.fn(async () => events.push('back'))
    const openAgentHistory = vi.fn(async () => {
      events.push('agent-history')
      return { href: 'orca-mobile-web://build/h/host/agent-history/workspace' }
    })
    const waitForDocument = vi.fn(async ({ expectedHrefIncludes }) => {
      const route = expectedHrefIncludes ? 'session' : 'workspace'
      events.push(route)
      return { href: `orca-mobile-web://build/h/host/${route}` }
    })
    const waitForNativeControl = vi.fn(async () => {
      events.push('native-shell')
      return { label: 'Open settings' }
    })

    const evidence = await verifyHostedAndroidHardwareBackJourney(
      {
        adb: '/sdk/adb',
        discoveryUrl: 'http://127.0.0.1:9222',
        emulator: { adb: '/sdk/adb' },
        sessionDocument: { href: 'orca-mobile-web://build/h/host/session/workspace' },
        timeoutMs: 30_000,
        workspaceMarker: 'MOBILE-REARCH'
      },
      { openAgentHistory, pressBack, waitForDocument, waitForNativeControl }
    )

    expect(events).toEqual([
      'agent-history',
      'back',
      'session',
      'back',
      'workspace',
      'back',
      'native-shell'
    ])
    expect(evidence).toEqual({
      nestedRoute: 'orca-mobile-web://build/h/host/agent-history/workspace',
      returnedSessionRoute: 'orca-mobile-web://build/h/host/session',
      workspaceRootRoute: 'orca-mobile-web://build/h/host/workspace',
      nativeShellControl: 'Open settings',
      hardwareBackPresses: 3
    })
    expect(waitForDocument).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ expectedHrefIncludes: '/session/', expectedText: '1 tab' })
    )
    expect(waitForNativeControl).toHaveBeenCalledWith(
      { adb: '/sdk/adb' },
      [
        'Open settings',
        'Open sessions in Chat UI',
        'Open sessions in the terminal',
        'Show paired hosts'
      ],
      30_000
    )
  })

  it('rejects a nested route that remains visible at the workspace step', async () => {
    await expect(
      verifyHostedAndroidHardwareBackJourney(
        {
          adb: '/sdk/adb',
          discoveryUrl: 'http://127.0.0.1:9222',
          emulator: { adb: '/sdk/adb' },
          sessionDocument: { href: 'orca-mobile-web://build/h/host/session/workspace' },
          timeoutMs: 30_000,
          workspaceMarker: 'MOBILE-REARCH'
        },
        {
          openAgentHistory: async () => ({ href: '/agent-history/' }),
          pressBack: async () => {},
          waitForWorkspaceRoot: async () => ({ href: '/agent-history/' }),
          waitForDocument: async ({ expectedHrefIncludes }) => ({
            href: expectedHrefIncludes ? '/session/' : '/agent-history/'
          }),
          waitForNativeControl: vi.fn()
        }
      )
    ).rejects.toThrow('did not reach the workspace root')
  })
})
