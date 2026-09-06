import { describe, expect, it, vi } from 'vitest'
import { PNG } from 'pngjs'
import {
  copyHostedIosPhotoFixtureToClipboard,
  stageFreshHostedIosPhotoFixture,
  pngPixelIdentity,
  verifyHostedIosTerminalClipboardImagePaste
} from '../../scripts/hosted-ios-terminal-clipboard-image-paste.mjs'

const uploadedPath =
  '/var/folders/x/y/T/orca-paste-1780000000000-00000000-0000-4000-8000-000000000000.png'
const sessionDocument = {
  href: 'orca-mobile-web://build/h/host/session/workspace'
}
const args = {
  deviceUdid: 'simulator',
  discoveryUrl: 'http://127.0.0.1:9222',
  emulator: { deviceUdid: 'simulator' },
  orcaCli: './config/scripts/orca-dev.mjs',
  pairingRuntimeUserDataPath: '/tmp/pairing/userData',
  sessionDocument,
  terminalHandle: 'terminal-handle',
  timeoutMs: 30_000,
  worktree: '/repo/mobile-rearch'
}
const fixtureBytes = createPng([18, 22, 41, 255])
const fixturePixelIdentity = pngPixelIdentity(fixtureBytes)

describe('hosted iOS terminal clipboard image paste', () => {
  it('normalizes Photos to its library and copies the latest visible photo', async () => {
    const runCommand = vi.fn().mockResolvedValue({ stdout: '', stderr: '' })
    const tapControl = vi.fn().mockResolvedValue({ x: 0.5, y: 0.5 })
    const tapLastControl = vi.fn().mockResolvedValue({ x: 0.16, y: 0.52 })
    const tapPoint = vi.fn()
    const waitForControl = vi.fn().mockResolvedValue({ x: 0.5, y: 0.5 })
    const waitForMatch = vi.fn().mockResolvedValue({ label: 'Share', x: 0.1, y: 0.9 })

    await expect(
      copyHostedIosPhotoFixtureToClipboard(
        {
          deviceUdid: 'simulator',
          emulator: args.emulator,
          fixturePath: '/repo/mobile/assets/favicon.png',
          timeoutMs: args.timeoutMs
        },
        {
          readFixture: vi.fn().mockResolvedValue(fixtureBytes),
          runCommand,
          stageFixture: vi.fn().mockResolvedValue('/repo/mobile/assets/favicon.png'),
          tapControl,
          tapLastControl,
          tapPoint,
          waitForControl,
          waitForMatch
        }
      )
    ).resolves.toMatchObject({
      fixtureName: 'favicon.png',
      fixturePixelIdentity,
      photoPoint: { x: 0.16, y: 0.52 }
    })

    expect(runCommand).toHaveBeenNthCalledWith(1, 'xcrun', [
      'simctl',
      'addmedia',
      'simulator',
      '/repo/mobile/assets/favicon.png'
    ])
    expect(runCommand).toHaveBeenNthCalledWith(2, 'xcrun', [
      'simctl',
      'launch',
      'simulator',
      'com.apple.mobileslideshow'
    ])
    expect(tapControl.mock.calls.map(([, label]) => label)).toEqual([
      'Back',
      'Share',
      'Copy Photo',
      'Return to Orca'
    ])
    expect(tapLastControl).toHaveBeenCalledWith(args.emulator, 'Photo', args.timeoutMs)
    expect(tapPoint).not.toHaveBeenCalled()
  })

  it('stages a freshly written copy so the fixture is the newest library photo', async () => {
    const writeFixture = vi.fn().mockResolvedValue(undefined)

    await expect(
      stageFreshHostedIosPhotoFixture('/repo/mobile/assets/favicon.png', {
        createDirectory: vi.fn().mockResolvedValue('/tmp/staged'),
        readFixture: vi.fn().mockResolvedValue(fixtureBytes),
        writeFixture
      })
    ).resolves.toBe('/tmp/staged/favicon.png')
    expect(writeFixture).toHaveBeenCalledWith('/tmp/staged/favicon.png', fixtureBytes)
  })

  it('dismisses first-launch Photos surfaces before copying', async () => {
    const waitForMatch = vi
      .fn()
      .mockResolvedValueOnce({ label: 'Continue', x: 0.5, y: 0.9 })
      .mockResolvedValueOnce({ label: 'Don’t Allow', x: 0.3, y: 0.6 })
      .mockResolvedValueOnce({ label: 'Continue', x: 0.5, y: 0.9 })
      .mockResolvedValueOnce({ label: 'Select', x: 0.8, y: 0.1 })
    const tapPoint = vi.fn().mockResolvedValue(undefined)

    await copyHostedIosPhotoFixtureToClipboard(
      {
        deviceUdid: 'simulator',
        emulator: args.emulator,
        fixturePath: '/repo/mobile/assets/favicon.png',
        timeoutMs: args.timeoutMs
      },
      {
        readFixture: vi.fn().mockResolvedValue(fixtureBytes),
        runCommand: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
        stageFixture: vi.fn().mockResolvedValue('/repo/mobile/assets/favicon.png'),
        tapControl: vi.fn().mockResolvedValue({ x: 0.5, y: 0.5 }),
        tapLastControl: vi.fn().mockResolvedValue({ x: 0.16, y: 0.52 }),
        tapPoint,
        waitForControl: vi.fn().mockResolvedValue({ x: 0.5, y: 0.5 }),
        waitForMatch
      }
    )

    expect(tapPoint).toHaveBeenNthCalledWith(1, args.emulator, {
      label: 'Continue',
      x: 0.5,
      y: 0.9
    })
    expect(tapPoint).toHaveBeenNthCalledWith(2, args.emulator, {
      label: 'Don’t Allow',
      x: 0.3,
      y: 0.6
    })
    expect(tapPoint).toHaveBeenNthCalledWith(3, args.emulator, {
      label: 'Continue',
      x: 0.5,
      y: 0.9
    })
  })

  it('retries when Photos onboarding appears after the first photo tap', async () => {
    const waitForMatch = vi
      .fn()
      .mockResolvedValueOnce({ label: 'Select', x: 0.8, y: 0.1 })
      .mockResolvedValueOnce({ label: 'Continue', x: 0.5, y: 0.9 })
      .mockResolvedValueOnce({ label: 'Select', x: 0.8, y: 0.1 })
    const tapLastControl = vi.fn().mockResolvedValue({ x: 0.16, y: 0.52 })
    const tapPoint = vi.fn().mockResolvedValue(undefined)
    const waitForControl = vi
      .fn()
      .mockRejectedValueOnce(new Error('lazy onboarding'))
      .mockResolvedValue({ x: 0.5, y: 0.5 })

    await copyHostedIosPhotoFixtureToClipboard(
      {
        deviceUdid: 'simulator',
        emulator: args.emulator,
        fixturePath: '/repo/mobile/assets/favicon.png',
        timeoutMs: args.timeoutMs
      },
      {
        readFixture: vi.fn().mockResolvedValue(fixtureBytes),
        runCommand: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
        stageFixture: vi.fn().mockResolvedValue('/repo/mobile/assets/favicon.png'),
        tapControl: vi.fn().mockResolvedValue({ x: 0.5, y: 0.5 }),
        tapLastControl,
        tapPoint,
        waitForControl,
        waitForMatch
      }
    )

    expect(tapLastControl).toHaveBeenCalledTimes(2)
    expect(tapPoint).toHaveBeenCalledWith(args.emulator, {
      label: 'Continue',
      x: 0.5,
      y: 0.9
    })
  })

  it('requires pixel-identical shell upload and terminal-only path exposure', async () => {
    const beforeTerminal = ['ORCA_HOSTED_CLIPBOARD_TEXT_PASTE']
    const afterTerminal = [...beforeTerminal, uploadedPath]
    const operations = {
      allowPaste: vi.fn().mockResolvedValue('allowed'),
      copyFixture: vi.fn().mockResolvedValue({
        copyPoint: { x: 0.15, y: 0.66 },
        fixtureName: 'favicon.png',
        fixturePixelIdentity
      }),
      readState: vi.fn().mockResolvedValue({ bodyText: 'Mobile Emulator' }),
      readTerminal: vi
        .fn()
        .mockResolvedValueOnce(beforeTerminal)
        .mockResolvedValueOnce(afterTerminal),
      readUploadedFile: vi.fn().mockResolvedValue(fixtureBytes),
      tapControl: vi.fn().mockResolvedValue({ x: 0.3, y: 0.9 }),
      waitForDocument: vi.fn().mockResolvedValue(sessionDocument)
    }

    await expect(verifyHostedIosTerminalClipboardImagePaste(args, operations)).resolves.toEqual({
      evidence: {
        copyPoint: { x: 0.15, y: 0.66 },
        fixtureName: 'favicon.png',
        height: 1,
        pasteControlPoint: { x: 0.3, y: 0.9 },
        pastePermissionPrompt: 'allowed',
        pixelSha256: fixturePixelIdentity.sha256,
        privilegedPageMarkers: 'absent',
        route: sessionDocument.href,
        size: fixtureBytes.byteLength,
        terminalPathInjected: true,
        width: 1
      },
      sessionDocument
    })
    expect(operations.readUploadedFile).toHaveBeenCalledWith(uploadedPath)
  })

  it('rejects a clipboard upload with different decoded pixels', async () => {
    const operations = {
      allowPaste: vi.fn().mockResolvedValue('not-shown'),
      copyFixture: vi.fn().mockResolvedValue({
        copyPoint: { x: 0.15, y: 0.66 },
        fixtureName: 'favicon.png',
        fixturePixelIdentity
      }),
      readState: vi.fn().mockResolvedValue({ bodyText: 'Mobile Emulator' }),
      readTerminal: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([uploadedPath]),
      readUploadedFile: vi.fn().mockResolvedValue(createPng([255, 0, 0, 255])),
      tapControl: vi.fn().mockResolvedValue({ x: 0.3, y: 0.9 }),
      waitForDocument: vi.fn().mockResolvedValue(sessionDocument)
    }

    await expect(verifyHostedIosTerminalClipboardImagePaste(args, operations)).rejects.toThrow(
      'did not preserve the fixture pixels'
    )
  })
})

function createPng(rgba: [number, number, number, number]): Buffer {
  const png = new PNG({ height: 1, width: 1 })
  png.data.set(rgba)
  return PNG.sync.write(png)
}
