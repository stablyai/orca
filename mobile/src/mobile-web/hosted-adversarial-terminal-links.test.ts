import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  HOSTED_TERMINAL_HTTP_LINK_LABEL,
  HOSTED_TERMINAL_JAVASCRIPT_LINK_LABEL,
  HOSTED_TERMINAL_FILE_LINK_LABEL,
  hostedAdversarialTerminalLinkCommand,
  hostedAdversarialTerminalLinkSafetyEvidence,
  stageHostedAdversarialTerminalLinksWithInput,
  verifyHostedAdversarialTerminalLinks
} from '../../scripts/hosted-adversarial-terminal-links.mjs'

const androidHarnessSource = readFileSync(
  new URL('../../scripts/run-hosted-android-source-control-review-e2e.mjs', import.meta.url),
  'utf8'
)
const androidTerminalHarnessSource = readFileSync(
  new URL('../../scripts/hosted-android-adversarial-terminal-links.mjs', import.meta.url),
  'utf8'
)
const iosHarnessSource = readFileSync(
  new URL('../../scripts/run-hosted-webview-simulator-e2e.mjs', import.meta.url),
  'utf8'
)

describe('hosted adversarial terminal links', () => {
  it('emits bounded OSC-8 HTTP and javascript rows through a portable Node command', () => {
    const command = hostedAdversarialTerminalLinkCommand(43210, 'PROBE-TOKEN', '001-adversarial.md')
    const encoded = command.match(/Buffer\.from\('([^']+)'/)?.[1]

    expect(command).not.toContain('javascript:')
    expect(encoded).toBeTruthy()
    const output = Buffer.from(encoded ?? '', 'base64').toString()
    expect(output).toContain('\u001B]8;;http://127.0.0.1:43210/terminal-link/PROBE-TOKEN\u001B\\')
    expect(output).toContain(
      "\u001B]8;;javascript:globalThis.__ORCA_HOSTED_TERMINAL_LINK_EXECUTED__='executed'\u001B\\"
    )
    expect(output).toContain('\u001B]8;;001-adversarial.md\u001B\\')
    expect(output.match(new RegExp(HOSTED_TERMINAL_HTTP_LINK_LABEL, 'gu'))).toHaveLength(2)
    expect(output.match(new RegExp(HOSTED_TERMINAL_JAVASCRIPT_LINK_LABEL, 'gu'))).toHaveLength(2)
    expect(output.match(new RegExp(HOSTED_TERMINAL_FILE_LINK_LABEL, 'gu'))).toHaveLength(2)
  })

  it('proves the allowed file tap before rejecting a native javascript tap', async () => {
    const initialDocument = {
      href: 'orca-mobile-web://build/h/host/session/workspace'
    }
    const resumedDocument = {
      href: 'orca-mobile-web://build/h/host/session/workspace',
      targetId: 'resumed'
    }
    const filePoint = { x: 0.2, y: 0.7 }
    const httpPoint = { x: 0.2, y: 0.6 }
    const javascriptPoint = { x: 0.2, y: 0.8 }
    const probe = {
      observations: [],
      port: 43210,
      reset() {
        this.observations.splice(0)
      },
      token: 'PROBE-TOKEN'
    }
    const tapPoint = vi.fn().mockResolvedValue(undefined)
    const waitForDocument = vi.fn().mockResolvedValue(resumedDocument)
    const writeLinks = vi.fn().mockResolvedValue('terminal-handle')

    await expect(
      verifyHostedAdversarialTerminalLinks(
        {
          discoveryUrl: 'http://127.0.0.1:9222',
          document: initialDocument,
          emulator: { deviceUdid: 'simulator' },
          orcaCli: './config/scripts/orca-dev.mjs',
          pairingRuntimeUserDataPath: '/tmp/pairing/userData',
          positiveFilePath: '001-adversarial.md',
          probe,
          tapPoint,
          terminalHandle: 'terminal-handle',
          timeoutMs: 30_000,
          worktree: '/repo/mobile-rearch'
        },
        {
          activateTerminal: vi.fn().mockResolvedValue(undefined),
          enableDiagnostics: vi.fn().mockResolvedValue(undefined),
          readPoints: vi
            .fn()
            .mockResolvedValueOnce({
              file: filePoint,
              http: httpPoint,
              javascript: javascriptPoint
            })
            .mockResolvedValueOnce({
              file: filePoint,
              http: httpPoint,
              javascript: javascriptPoint
            }),
          readState: vi.fn().mockResolvedValue({
            href: resumedDocument.href,
            javascriptMarkerPresent: false,
            javascriptMarkerValue: null
          }),
          settle: vi.fn().mockResolvedValue(undefined),
          waitForDocument,
          writeLinks
        }
      )
    ).resolves.toEqual({
      evidence: {
        fileLinkOpenedAfterNativeTap: true,
        httpLinkRequestedWithoutTap: false,
        javascriptLinkEscaped: false,
        javascriptLinkExecuted: false,
        javascriptTapPoint: javascriptPoint,
        routeRetained: true,
        terminalHandle: 'terminal-handle'
      },
      sessionDocument: resumedDocument
    })

    expect(tapPoint).toHaveBeenNthCalledWith(1, { deviceUdid: 'simulator' }, filePoint)
    expect(tapPoint).toHaveBeenNthCalledWith(2, { deviceUdid: 'simulator' }, javascriptPoint)
    expect(writeLinks).toHaveBeenCalledWith({
      orcaCli: './config/scripts/orca-dev.mjs',
      pairingRuntimeUserDataPath: '/tmp/pairing/userData',
      positiveFilePath: '001-adversarial.md',
      probePort: 43210,
      probeToken: 'PROBE-TOKEN',
      terminalHandle: 'terminal-handle',
      timeoutMs: 30_000,
      worktree: '/repo/mobile-rearch'
    })
    expect(waitForDocument).toHaveBeenCalledWith({
      discoveryUrl: 'http://127.0.0.1:9222',
      expectedHrefIncludes: '/session/',
      expectedText: '001-adversarial.md',
      requireInteractiveControls: false,
      timeoutMs: 5_000
    })
    expect(probe.observations).toEqual([])
  })

  it('fails closed on execution, navigation, or escaped network traffic', () => {
    const safeState = {
      href: 'orca-mobile-web://build/h/host/session/workspace',
      javascriptMarkerPresent: false,
      javascriptMarkerValue: null
    }
    expect(
      hostedAdversarialTerminalLinkSafetyEvidence({
        observations: [],
        state: safeState
      })
    ).toEqual({
      javascriptLinkEscaped: false,
      javascriptLinkExecuted: false,
      routeRetained: true
    })
    expect(() =>
      hostedAdversarialTerminalLinkSafetyEvidence({
        observations: [],
        state: {
          ...safeState,
          javascriptMarkerPresent: true,
          javascriptMarkerValue: 'executed'
        }
      })
    ).toThrow('javascript link executed')
    expect(() =>
      hostedAdversarialTerminalLinkSafetyEvidence({
        observations: ['http:/terminal-link/PROBE-TOKEN'],
        state: safeState
      })
    ).toThrow('javascript link escaped')
  })

  it('retries a missed native file-link activation before testing javascript', async () => {
    const document = { href: 'orca-mobile-web://build/h/host/session/workspace' }
    const tapPoint = vi.fn().mockResolvedValue(undefined)
    const waitForDocument = vi
      .fn()
      .mockRejectedValueOnce(new Error('missed native touch'))
      .mockResolvedValue(document)
    const readPoints = vi.fn().mockResolvedValue({
      file: { x: 0.2, y: 0.7 },
      http: { x: 0.2, y: 0.6 },
      javascript: { x: 0.2, y: 0.8 }
    })

    await verifyHostedAdversarialTerminalLinks(
      {
        discoveryUrl: 'http://127.0.0.1:9222',
        document,
        emulator: {},
        positiveFilePath: '001-adversarial.md',
        probe: { observations: [], port: 43210, token: 'PROBE-TOKEN' },
        tapPoint,
        timeoutMs: 30_000
      },
      {
        activateTerminal: vi.fn().mockResolvedValue(undefined),
        enableDiagnostics: vi.fn().mockResolvedValue(undefined),
        readPoints,
        readState: vi.fn().mockResolvedValue({
          href: document.href,
          javascriptMarkerPresent: false,
          javascriptMarkerValue: null
        }),
        settle: vi.fn().mockResolvedValue(undefined),
        waitForDocument,
        writeLinks: vi.fn().mockResolvedValue('terminal-handle')
      }
    )

    expect(waitForDocument).toHaveBeenCalledTimes(2)
    expect(readPoints).toHaveBeenCalledTimes(3)
    expect(tapPoint).toHaveBeenCalledTimes(3)
  })

  it('taps the duplicate file-link row after a missed native activation', async () => {
    const document = { href: 'orca-mobile-web://build/h/host/session/workspace' }
    const file = { x: 0.2, y: 0.7 }
    const fileAlternate = { x: 0.2, y: 0.72 }
    const tapPoint = vi.fn().mockResolvedValue(undefined)
    const prepareFileTap = vi.fn().mockResolvedValue(undefined)

    await verifyHostedAdversarialTerminalLinks(
      {
        discoveryUrl: 'http://127.0.0.1:9222',
        document,
        emulator: {},
        positiveFilePath: '001-adversarial.md',
        probe: { observations: [], port: 43210, token: 'PROBE-TOKEN' },
        tapPoint,
        timeoutMs: 30_000
      },
      {
        activateTerminal: vi.fn().mockResolvedValue(undefined),
        enableDiagnostics: vi.fn().mockResolvedValue(undefined),
        prepareFileTap,
        readPoints: vi.fn().mockResolvedValue({
          file,
          fileAlternate,
          http: { x: 0.2, y: 0.6 },
          javascript: { x: 0.2, y: 0.8 }
        }),
        readState: vi.fn().mockResolvedValue({
          href: document.href,
          javascriptMarkerPresent: false,
          javascriptMarkerValue: null
        }),
        settle: vi.fn().mockResolvedValue(undefined),
        waitForDocument: vi
          .fn()
          .mockRejectedValueOnce(new Error('missed'))
          .mockResolvedValue(document),
        writeLinks: vi.fn().mockResolvedValue('terminal-handle')
      }
    )

    expect(tapPoint).toHaveBeenNthCalledWith(1, {}, file)
    expect(tapPoint).toHaveBeenNthCalledWith(2, {}, fileAlternate)
    expect(prepareFileTap).toHaveBeenCalledTimes(2)
  })

  it('retries missed live terminal activations without changing the staged command', async () => {
    const inputCommand = vi.fn().mockResolvedValue(undefined)
    const waitForStage = vi
      .fn()
      .mockRejectedValueOnce(new Error('missed'))
      .mockRejectedValueOnce(new Error('missed'))
      .mockResolvedValue(undefined)
    const prepared = {
      command: 'node .git/stage.cjs',
      terminalHandle: 'terminal-handle'
    }
    const prepare = vi.fn().mockResolvedValue(prepared)

    await expect(
      stageHostedAdversarialTerminalLinksWithInput({ timeoutMs: 30_000 }, inputCommand, {
        prepare,
        waitForStage
      })
    ).resolves.toBe('terminal-handle')

    expect(inputCommand).toHaveBeenCalledTimes(3)
    expect(inputCommand).toHaveBeenCalledWith(prepared.command)
    expect(prepare).toHaveBeenCalledWith({ timeoutMs: 30_000 })
    expect(waitForStage).toHaveBeenCalledTimes(3)
    expect(waitForStage).toHaveBeenCalledWith(prepared, 5_000)
  })

  it('keeps the exact iOS and Android adversarial gates wired to the same corpus', () => {
    expect(iosHarnessSource).toContain('verifyHostedIosAdversarialTerminalLinks')
    expect(androidHarnessSource).toContain('verifyHostedAndroidAdversarialTerminalLinks')
    expect(androidTerminalHarnessSource).toContain('verifyHostedAdversarialTerminalLinks')
    expect(iosHarnessSource).toContain('adversarial terminal links')
    expect(androidHarnessSource).toContain('adversarial terminal links')
  })
})
