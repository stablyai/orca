import { describe, expect, it, vi } from 'vitest'
import {
  HOSTED_IOS_DOCUMENT_FIXTURE_NAME,
  openHostedIosDocumentPicker,
  parseLocalFileProviderGroupPath,
  seedHostedIosDocumentFixture,
  selectHostedIosDocumentFixture,
  uploadedPathsFromTerminalSnapshot,
  verifyHostedIosDocumentUpload
} from '../../scripts/hosted-ios-document-upload.mjs'

const fixture = {
  destinationPath: '/simulator/File Provider Storage/orca-document-upload-fixture.png',
  fixtureName: HOSTED_IOS_DOCUMENT_FIXTURE_NAME,
  sha256: 'dec4a91731905b9e8ed450a6c46931258528fc034fcfc64d95b0b23264f8e9d4',
  size: 123
}
const uploadedPath =
  '/var/folders/x/y/T/orca-paste-1780000000000-00000000-0000-4000-8000-000000000000.png'
const args = {
  discoveryUrl: 'http://127.0.0.1:9222',
  documentFixture: fixture,
  emulator: { deviceUdid: 'simulator' },
  orcaCli: './config/scripts/orca-dev.mjs',
  pairingRuntimeUserDataPath: '/tmp/pairing/userData',
  sessionDocument: { href: 'orca-mobile-web://build/h/host/session/workspace' },
  terminalHandle: 'terminal-handle',
  timeoutMs: 30_000,
  worktree: '/repo/mobile-rearch'
}
const fixtureBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAIAAADYYG7Q', 'base64')

describe('hosted iOS document upload', () => {
  it('resolves and seeds the simulator Local File Provider container', async () => {
    const runCommand = vi.fn().mockResolvedValue({
      stdout:
        'group.com.apple.DocumentManager\t/simulator/document-manager\n' +
        'group.com.apple.FileProvider.LocalStorage\t/simulator/local-files\n'
    })
    const copy = vi.fn().mockResolvedValue(undefined)
    const createDirectory = vi.fn().mockResolvedValue(undefined)
    const readFixture = vi.fn().mockResolvedValue(Buffer.alloc(123))
    const touch = vi.fn().mockResolvedValue(undefined)

    await seedHostedIosDocumentFixture(
      {
        deviceUdid: 'simulator',
        fixturePath: '/repo/mobile/assets/favicon.png'
      },
      { copy, createDirectory, readFixture, runCommand, touch }
    )

    expect(runCommand).toHaveBeenCalledWith(
      'xcrun',
      ['simctl', 'get_app_container', 'simulator', 'com.apple.DocumentsApp', 'groups'],
      { encoding: 'utf8' }
    )
    expect(createDirectory).toHaveBeenCalledWith('/simulator/local-files/File Provider Storage', {
      recursive: true
    })
    expect(copy).toHaveBeenCalledWith(
      '/repo/mobile/assets/favicon.png',
      '/simulator/local-files/File Provider Storage/orca-document-upload-fixture.png'
    )
    expect(touch).toHaveBeenCalled()
  })

  it('rejects a missing Local File Provider group', () => {
    expect(() =>
      parseLocalFileProviderGroupPath(
        'group.com.apple.DocumentManager\t/simulator/document-manager'
      )
    ).toThrow('Local File Provider container was not found')
  })

  it('falls back through Browse and On My iPhone to select the seeded file', async () => {
    const tapByPrefix = vi.fn().mockResolvedValueOnce({ x: 0.5, y: 0.4 })
    const tapFixture = vi
      .fn()
      .mockRejectedValueOnce(new Error('not in Recents'))
      .mockRejectedValueOnce(new Error('not in Browse root'))
      .mockResolvedValueOnce({ x: 0.5, y: 0.3 })
    const tapControl = vi.fn().mockResolvedValue({ x: 0.2, y: 0.9 })
    const waitForPickerDismissal = vi.fn().mockResolvedValue(undefined)

    await expect(
      selectHostedIosDocumentFixture(
        args.emulator,
        HOSTED_IOS_DOCUMENT_FIXTURE_NAME,
        args.timeoutMs,
        { tapByPrefix, tapControl, tapFixture, waitForPickerDismissal }
      )
    ).resolves.toEqual({ x: 0.5, y: 0.3 })

    expect(tapControl).toHaveBeenCalledWith(args.emulator, 'Browse', 5_000)
    expect(tapByPrefix).toHaveBeenCalledWith(args.emulator, 'On My iPhone', 5_000)
    expect(tapFixture).toHaveBeenLastCalledWith(
      args.emulator,
      'orca-document-upload-fixture',
      { x: 0.5, y: 0.25 },
      args.timeoutMs
    )
    expect(waitForPickerDismissal).toHaveBeenCalledWith(args.emulator, 'Browse', 3_000)
  })

  it('splits abutting uploaded paths instead of fusing them', () => {
    const first =
      '/var/folders/x/y/T/orca-paste-1780000000000-00000000-0000-4000-8000-000000000000.png'
    const second =
      '/var/folders/x/y/T/orca-paste-1780000000001-00000000-0000-4000-8000-000000000001.png'
    expect(uploadedPathsFromTerminalSnapshot([first + second])).toEqual([first, second])
  })

  it('reconstructs wrapped uploaded paths from terminal rows', () => {
    expect(
      uploadedPathsFromTerminalSnapshot([
        '/orca/ORCA_HOSTED_CLIPBOARD_TEXT_PASTE/var/folders/x/y/T/orca-paste-1780000',
        '000000-00000000-0000-4000-8000-000000000000.png'
      ])
    ).toEqual([
      '/var/folders/x/y/T/orca-paste-1780000000000-00000000-0000-4000-8000-000000000000.png'
    ])
  })

  it('uses the physical long press when it opens the native picker', async () => {
    const longPressPoint = vi.fn().mockResolvedValue(undefined)
    const waitForPicker = vi.fn().mockResolvedValue({ x: 0.2, y: 0.9 })
    const dispatchWebLongPress = vi.fn()

    await expect(
      openHostedIosDocumentPicker(
        {
          document: args.sessionDocument,
          emulator: args.emulator,
          point: { x: 0.75, y: 0.9 }
        },
        { dispatchWebLongPress, longPressPoint, waitForPicker }
      )
    ).resolves.toBe('native-long-press')

    expect(dispatchWebLongPress).not.toHaveBeenCalled()
  })

  it('retains native gesture authority while completing the RNW long press', async () => {
    const longPressPoint = vi.fn().mockResolvedValue(undefined)
    const waitForPicker = vi
      .fn()
      .mockRejectedValueOnce(new Error('picker not visible'))
      .mockResolvedValueOnce({ x: 0.2, y: 0.9 })
    const dispatchWebLongPress = vi.fn().mockResolvedValue(undefined)

    await expect(
      openHostedIosDocumentPicker(
        {
          document: args.sessionDocument,
          emulator: args.emulator,
          point: { x: 0.75, y: 0.9 }
        },
        { dispatchWebLongPress, longPressPoint, waitForPicker }
      )
    ).resolves.toBe('native-touch-plus-web-responder')

    expect(dispatchWebLongPress).toHaveBeenCalledWith(args.sessionDocument, 'Attach a photo')
    expect(waitForPicker).toHaveBeenLastCalledWith(args.emulator, 'Browse', 5_000)
  })

  it('repeats the combined gesture when WebKit drops the first responder hold', async () => {
    const longPressPoint = vi.fn().mockResolvedValue(undefined)
    const waitForPicker = vi
      .fn()
      .mockRejectedValueOnce(new Error('physical hold did not open picker'))
      .mockRejectedValueOnce(new Error('first responder hold did not open picker'))
      .mockRejectedValueOnce(new Error('second physical hold did not open picker'))
      .mockResolvedValueOnce({ x: 0.2, y: 0.9 })
    const dispatchWebLongPress = vi.fn().mockResolvedValue(undefined)

    await expect(
      openHostedIosDocumentPicker(
        {
          document: args.sessionDocument,
          emulator: args.emulator,
          point: { x: 0.75, y: 0.9 }
        },
        { dispatchWebLongPress, longPressPoint, waitForPicker }
      )
    ).resolves.toBe('native-touch-plus-web-responder')

    expect(longPressPoint).toHaveBeenCalledTimes(2)
    expect(dispatchWebLongPress).toHaveBeenCalledTimes(2)
  })

  it('selects through unchanged Attach and verifies terminal-only byte identity', async () => {
    const before = ['ORCA_HOSTED_CLIPBOARD_TEXT_PASTE']
    const after = [...before, uploadedPath]
    const operations = {
      fileStat: vi.fn().mockResolvedValue({ size: fixtureBytes.byteLength }),
      openPicker: vi.fn().mockResolvedValue('native-touch-plus-web-responder'),
      readAccessibilityPoint: vi.fn().mockResolvedValue({ x: 0.74, y: 0.89 }),
      readControlPoint: vi.fn().mockResolvedValue({ x: 0.75, y: 0.9 }),
      readState: vi.fn().mockResolvedValue({ bodyText: 'Mobile Emulator' }),
      readTerminal: vi.fn().mockResolvedValueOnce(before).mockResolvedValueOnce(after),
      readUploadedFile: vi.fn().mockResolvedValue(fixtureBytes),
      selectFixture: vi.fn().mockResolvedValue({ x: 0.5, y: 0.5 }),
      waitForDocument: vi.fn().mockResolvedValue(args.sessionDocument)
    }
    const documentFixture = {
      ...fixture,
      sha256: '1b0a38dc09fb7fe56599abeab066965c1b7791815e7dd08483938630b0d15226',
      size: fixtureBytes.byteLength
    }

    await expect(
      verifyHostedIosDocumentUpload({ ...args, documentFixture }, operations)
    ).resolves.toEqual({
      evidence: {
        attachAccessibilityPoint: { x: 0.74, y: 0.89 },
        attachControlPoint: { x: 0.75, y: 0.9 },
        fixtureName: HOSTED_IOS_DOCUMENT_FIXTURE_NAME,
        privilegedPageMarkers: 'absent',
        pickerActivation: 'native-touch-plus-web-responder',
        route: args.sessionDocument.href,
        selectedFilePoint: { x: 0.5, y: 0.5 },
        sha256: documentFixture.sha256,
        size: fixtureBytes.byteLength,
        terminalPathInjected: true
      },
      sessionDocument: args.sessionDocument
    })
    expect(operations.readControlPoint).toHaveBeenCalledWith(args.sessionDocument, 'Attach a photo')
    expect(operations.openPicker).toHaveBeenCalledWith({
      document: args.sessionDocument,
      emulator: args.emulator,
      point: { x: 0.75, y: 0.9 }
    })
    expect(operations.readUploadedFile).toHaveBeenCalledWith(uploadedPath)
  })

  it('rejects selected bytes exposed in hosted page state', async () => {
    const documentFixture = {
      ...fixture,
      sha256: '1b0a38dc09fb7fe56599abeab066965c1b7791815e7dd08483938630b0d15226',
      size: fixtureBytes.byteLength
    }
    const operations = {
      fileStat: vi.fn().mockResolvedValue({ size: fixtureBytes.byteLength }),
      openPicker: vi.fn().mockResolvedValue('native-touch-plus-web-responder'),
      readAccessibilityPoint: vi.fn().mockResolvedValue({ x: 0.74, y: 0.89 }),
      readControlPoint: vi.fn().mockResolvedValue({ x: 0.75, y: 0.9 }),
      readState: vi.fn().mockResolvedValue({
        bodyText: `Mobile Emulator ${fixtureBytes.toString('base64').slice(0, 16)}`
      }),
      readTerminal: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([uploadedPath]),
      readUploadedFile: vi.fn().mockResolvedValue(fixtureBytes),
      selectFixture: vi.fn().mockResolvedValue({ x: 0.5, y: 0.5 }),
      waitForDocument: vi.fn().mockResolvedValue(args.sessionDocument)
    }

    await expect(
      verifyHostedIosDocumentUpload({ ...args, documentFixture }, operations)
    ).rejects.toThrow('exposed privileged page marker')
  })

  it('reports the native shell attachment error before the terminal timeout', async () => {
    const operations = {
      openPicker: vi.fn().mockResolvedValue('native-touch-plus-web-responder'),
      readAccessibilityPoint: vi.fn().mockResolvedValue({ x: 0.74, y: 0.89 }),
      readControlPoint: vi.fn().mockResolvedValue({ x: 0.75, y: 0.9 }),
      readState: vi.fn().mockResolvedValue({ bodyText: 'Mobile Emulator Attach failed' }),
      readTerminal: vi.fn().mockResolvedValue([]),
      selectFixture: vi.fn().mockResolvedValue({ x: 0.5, y: 0.3 })
    }

    await expect(
      verifyHostedIosDocumentUpload({ ...args, timeoutMs: 100 }, operations)
    ).rejects.toThrow('Selected document upload failed in the native shell: Attach failed')
  })
})
