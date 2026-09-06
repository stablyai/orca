import { describe, expect, it, vi } from 'vitest'
import {
  resetHostedIosPhotosPermission,
  verifyHostedIosPhotoPermissionDenial
} from '../../scripts/hosted-ios-photo-permission-denial.mjs'

const args = {
  discoveryUrl: 'http://127.0.0.1:9222',
  emulator: { deviceUdid: 'simulator' },
  orcaCli: './config/scripts/orca-dev.mjs',
  pairingRuntimeUserDataPath: '/tmp/pairing/userData',
  sessionDocument: {
    href: 'orca-mobile-web://build/h/host/session/workspace'
  },
  terminalHandle: 'terminal-handle',
  timeoutMs: 30_000,
  worktree: '/repo/mobile-rearch'
}

function createOperations() {
  return {
    readState: vi.fn().mockResolvedValue({
      bodyText: 'Mobile Emulator\nPhoto permission denied'
    }),
    readTerminal: vi.fn().mockResolvedValue(['ORCA_HOSTED_CLIPBOARD_TEXT_PASTE']),
    tapControl: vi.fn().mockResolvedValue({ x: 0.75, y: 0.9 }),
    tapPoint: vi.fn().mockResolvedValue(undefined),
    wait: vi.fn().mockResolvedValue(undefined),
    waitForDocument: vi.fn().mockResolvedValue(args.sessionDocument),
    waitForPrompt: vi.fn().mockResolvedValue({
      label: 'Don’t Allow',
      x: 0.5,
      y: 0.6
    })
  }
}

describe('hosted iOS Photos permission denial', () => {
  it('resets only the app Photos permission before launch', async () => {
    const runCommand = vi.fn().mockResolvedValue({ stdout: '', stderr: '' })

    await resetHostedIosPhotosPermission('simulator', runCommand)

    expect(runCommand).toHaveBeenCalledWith('xcrun', [
      'simctl',
      'privacy',
      'simulator',
      'reset',
      'photos',
      'com.stably.orca.mobile'
    ])
  })

  it('denies through the unchanged Attach flow without changing terminal output', async () => {
    const operations = createOperations()

    await expect(verifyHostedIosPhotoPermissionDenial(args, operations)).resolves.toEqual({
      evidence: {
        activationAttempts: 1,
        attachControlPoint: { x: 0.75, y: 0.9 },
        denialControl: { label: 'Don’t Allow', x: 0.5, y: 0.6 },
        privilegedPageMarkers: 'absent',
        route: args.sessionDocument.href,
        terminalOutput: 'unchanged',
        toast: 'Photo permission denied'
      },
      sessionDocument: args.sessionDocument
    })

    expect(operations.tapControl).toHaveBeenCalledWith(
      args.emulator,
      'Attach a photo',
      args.timeoutMs
    )
    expect(operations.waitForPrompt).toHaveBeenCalledWith(
      args.emulator,
      ['Don’t Allow', "Don't Allow"],
      5_000
    )
    expect(operations.tapPoint).toHaveBeenCalledWith(args.emulator, {
      label: 'Don’t Allow',
      x: 0.5,
      y: 0.6
    })
    expect(operations.readTerminal).toHaveBeenCalledTimes(2)
  })

  it('retries a silent Attach activation before denying the prompt', async () => {
    const operations = createOperations()
    operations.waitForPrompt
      .mockRejectedValueOnce(new Error('prompt not shown'))
      .mockResolvedValueOnce({ label: "Don't Allow", x: 0.5, y: 0.6 })

    const result = await verifyHostedIosPhotoPermissionDenial(args, operations)

    expect(result.evidence).toMatchObject({
      activationAttempts: 2,
      denialControl: { label: "Don't Allow" }
    })
    expect(operations.tapControl).toHaveBeenCalledTimes(2)
  })

  it('rejects a privileged image marker in hosted page state', async () => {
    const operations = createOperations()
    operations.readState.mockResolvedValue({
      bodyText: 'Photo permission denied\ndata:image/png;base64,AAAA'
    })

    await expect(verifyHostedIosPhotoPermissionDenial(args, operations)).rejects.toThrow(
      'exposed privileged page marker: data:image/'
    )
  })

  it('rejects any terminal output change after denial', async () => {
    const operations = createOperations()
    operations.readTerminal
      .mockResolvedValueOnce(['before'])
      .mockResolvedValueOnce(['before', '/tmp/orca-paste-private.png'])

    await expect(verifyHostedIosPhotoPermissionDenial(args, operations)).rejects.toThrow(
      'changed the Desktop terminal'
    )
  })

  it('accepts terminal row reflow when the character stream is unchanged', async () => {
    const operations = createOperations()
    operations.readTerminal
      .mockResolvedValueOnce([
        'jinwoo ~/orca/',
        'ORCA_HOSTED_CLIPBOARD_TEXT_PASTE',
        '/tmp/orca-paste.png'
      ])
      .mockResolvedValueOnce([
        'jinwoo ~/orca/workspaces/orca/mobile-rearch [mobile-rearch] $ ',
        'ORCA_HOSTED_CLIPBOARD_',
        'TEXT_PASTE/tmp/orca-paste.png'
      ])

    await expect(verifyHostedIosPhotoPermissionDenial(args, operations)).resolves.toBeDefined()
  })
})
