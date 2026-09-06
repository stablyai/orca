import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  activateControl: vi.fn()
}))

vi.mock('../../scripts/hosted-webview-cdp-session.mjs', () => ({
  activateHostedWebViewControl: mocks.activateControl,
  waitForVisibleHostedWebView: vi.fn()
}))

import {
  verifyHostedIosTerminalClipboardPaste,
  writeHostedIosSimulatorPasteboard
} from '../../scripts/hosted-ios-terminal-clipboard-paste.mjs'

describe('hosted iOS terminal clipboard paste', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('uses the unchanged Paste control and requires the marker in the Desktop terminal', async () => {
    const workspaceDocument = { href: 'orca-mobile-web://build/h/host' }
    const sessionDocument = {
      href: 'orca-mobile-web://build/h/host/session/workspace'
    }
    const writePasteboard = vi.fn().mockResolvedValue(undefined)
    const activateWorkspace = vi
      .fn()
      .mockImplementation(async (_document, _workspace, _activate, _timeout, waitForWorkspace) => {
        await waitForWorkspace()
      })
    const waitForDocument = vi
      .fn()
      .mockResolvedValueOnce(workspaceDocument)
      .mockResolvedValueOnce(sessionDocument)
    const tapControl = vi
      .fn()
      .mockResolvedValueOnce({ x: 0.75, y: 0.9 })
      .mockResolvedValueOnce({ x: 0.5, y: 0.6 })
    const readTerminal = vi.fn().mockResolvedValue('terminal-handle')

    await expect(
      verifyHostedIosTerminalClipboardPaste(
        {
          deviceUdid: 'simulator',
          discoveryUrl: 'http://127.0.0.1:9222',
          emulator: { deviceUdid: 'simulator' },
          expectedWorkspace: 'mobile-rearch',
          orcaCli: './config/scripts/orca-dev.mjs',
          pairingRuntimeUserDataPath: '/tmp/pairing/userData',
          timeoutMs: 30_000,
          workspaceDocument,
          worktree: '/repo/mobile-rearch'
        },
        {
          activateWorkspace,
          readTerminal,
          tapControl,
          waitForDocument,
          writePasteboard
        }
      )
    ).resolves.toEqual({
      evidence: {
        activationAttempts: 1,
        marker: 'ORCA_HOSTED_CLIPBOARD_TEXT_PASTE',
        pasteControlPoint: { x: 0.75, y: 0.9 },
        pastePermissionPrompt: 'allowed',
        route: sessionDocument.href,
        terminalHandle: 'terminal-handle'
      },
      sessionDocument
    })

    expect(writePasteboard).toHaveBeenCalledWith('simulator', 'ORCA_HOSTED_CLIPBOARD_TEXT_PASTE')
    expect(activateWorkspace).toHaveBeenCalledWith(
      workspaceDocument,
      'mobile-rearch',
      mocks.activateControl,
      30_000,
      expect.any(Function)
    )
    expect(tapControl).toHaveBeenNthCalledWith(1, { deviceUdid: 'simulator' }, 'Paste', 30_000)
    expect(tapControl).toHaveBeenNthCalledWith(2, { deviceUdid: 'simulator' }, 'Allow Paste', 3_000)
    expect(readTerminal).toHaveBeenCalledWith({
      marker: 'ORCA_HOSTED_CLIPBOARD_TEXT_PASTE',
      orcaCli: './config/scripts/orca-dev.mjs',
      pairingRuntimeUserDataPath: '/tmp/pairing/userData',
      timeoutMs: 10_000,
      worktree: '/repo/mobile-rearch'
    })
  })

  it('writes text to the selected simulator pasteboard', async () => {
    const stdin = { end: vi.fn() }
    const child = {
      once: vi.fn((event, listener) => {
        if (event === 'exit') {
          listener(0)
        }
      }),
      stderr: { on: vi.fn(), setEncoding: vi.fn() },
      stdin
    }
    const spawnProcess = vi.fn().mockReturnValue(child)

    await expect(
      writeHostedIosSimulatorPasteboard('simulator', 'marker', spawnProcess)
    ).resolves.toBeUndefined()

    expect(spawnProcess).toHaveBeenCalledWith('xcrun', ['simctl', 'pbcopy', 'simulator'], {
      stdio: ['pipe', 'ignore', 'pipe']
    })
    expect(stdin.end).toHaveBeenCalledWith('marker')
  })

  it('retries a silent native tap before accepting terminal evidence', async () => {
    const sessionDocument = {
      href: 'orca-mobile-web://build/h/host/session/workspace'
    }
    const tapControl = vi
      .fn()
      .mockResolvedValueOnce({ x: 0.25, y: 0.9 })
      .mockRejectedValueOnce(new Error('prompt not shown'))
      .mockResolvedValueOnce({ x: 0.25, y: 0.9 })
      .mockRejectedValueOnce(new Error('prompt not shown'))
    const readTerminal = vi
      .fn()
      .mockRejectedValueOnce(new Error('marker missing'))
      .mockResolvedValueOnce('terminal-handle')

    const result = await verifyHostedIosTerminalClipboardPaste(
      {
        deviceUdid: 'simulator',
        discoveryUrl: 'http://127.0.0.1:9222',
        emulator: { deviceUdid: 'simulator' },
        expectedWorkspace: 'mobile-rearch',
        orcaCli: './config/scripts/orca-dev.mjs',
        pairingRuntimeUserDataPath: '/tmp/pairing/userData',
        timeoutMs: 30_000,
        workspaceDocument: { href: 'orca-mobile-web://build/h/host' },
        worktree: '/repo/mobile-rearch'
      },
      {
        activateWorkspace: vi.fn().mockResolvedValue(undefined),
        readTerminal,
        tapControl,
        waitForDocument: vi.fn().mockResolvedValue(sessionDocument),
        writePasteboard: vi.fn().mockResolvedValue(undefined)
      }
    )

    expect(result.evidence).toMatchObject({
      activationAttempts: 2,
      pastePermissionPrompt: 'not-shown',
      terminalHandle: 'terminal-handle'
    })
    expect(readTerminal).toHaveBeenCalledTimes(2)
    expect(tapControl).toHaveBeenCalledTimes(4)
  })
})
