import { describe, expect, it, vi } from 'vitest'
import {
  backgroundHostedIosMobileApp,
  grantHostedIosPhotosPermission,
  launchHostedIosMobileApp,
  revokeHostedIosPhotosPermission,
  verifyHostedIosPhotoPermissionRevocation
} from '../../scripts/hosted-ios-photo-permission-revocation.mjs'

const args = {
  deviceUdid: 'simulator',
  discoveryUrl: 'http://127.0.0.1:9222',
  emulator: { deviceUdid: 'simulator' },
  expectedWorkspace: 'mobile-rearch',
  orcaCli: './config/scripts/orca-dev.mjs',
  pairingRuntimeUserDataPath: '/tmp/pairing/userData',
  sessionDocument: {
    href: 'orca-mobile-web://build/h/host/session/workspace'
  },
  terminalHandle: 'terminal-handle',
  timeoutMs: 30_000,
  worktree: '/repo/mobile-rearch'
}
const grantedDocument = {
  href: args.sessionDocument.href
    .replace('://build/', '://grant-restart/')
    .replace('/workspace', '/grant-workspace')
}
const revokedDocument = {
  href: args.sessionDocument.href
    .replace('://build/', '://revocation-restart/')
    .replace('/workspace', '/revoked-workspace')
}

function createOperations() {
  return {
    activateWorkspace: vi.fn().mockResolvedValue(undefined),
    backgroundApp: vi.fn().mockResolvedValue(undefined),
    dismissDeveloperMenu: vi.fn().mockResolvedValue(false),
    grantPermission: vi.fn().mockResolvedValue(undefined),
    launchApp: vi.fn().mockResolvedValue(undefined),
    openHybridRoute: vi.fn().mockResolvedValue(undefined),
    readState: vi.fn().mockResolvedValue({
      bodyText: 'Mobile Emulator\nPhoto permission denied'
    }),
    readTerminal: vi.fn().mockResolvedValue(['ORCA_HOSTED_CLIPBOARD_TEXT_PASTE']),
    revokePermission: vi.fn().mockResolvedValue(undefined),
    tapControl: vi
      .fn()
      .mockResolvedValueOnce({ x: 0.75, y: 0.9 })
      .mockResolvedValueOnce({ x: 0.75, y: 0.9 }),
    tapPoint: vi.fn().mockResolvedValue(undefined),
    wait: vi.fn().mockResolvedValue(undefined),
    waitForControl: vi.fn().mockResolvedValue({ label: 'Cancel', x: 0.9, y: 0.1 }),
    waitForPickerDismissal: vi.fn().mockResolvedValue(undefined),
    waitForDocument: vi
      .fn()
      .mockResolvedValueOnce(grantedDocument)
      .mockResolvedValueOnce(grantedDocument)
      .mockResolvedValueOnce(revokedDocument)
  }
}

describe('hosted iOS Photos permission revocation', () => {
  it.each([
    ['grant', grantHostedIosPhotosPermission],
    ['revoke', revokeHostedIosPhotosPermission]
  ])('%ss only the app Photos permission', async (action, changePermission) => {
    const runCommand = vi.fn().mockResolvedValue({ stdout: '', stderr: '' })

    await changePermission('simulator', runCommand)

    expect(runCommand).toHaveBeenCalledWith('xcrun', [
      'simctl',
      'privacy',
      'simulator',
      action,
      'photos',
      'com.stably.orca.mobile'
    ])
  })

  it('launches only the exact mobile app', async () => {
    const runCommand = vi.fn().mockResolvedValue({ stdout: '', stderr: '' })

    await launchHostedIosMobileApp('simulator', runCommand)

    expect(runCommand).toHaveBeenCalledWith('xcrun', [
      'simctl',
      'launch',
      'simulator',
      'com.stably.orca.mobile'
    ])
  })

  it('backgrounds through the emulator Home button', async () => {
    const runCommand = vi.fn().mockResolvedValue(undefined)

    await backgroundHostedIosMobileApp(args.emulator, runCommand)

    expect(runCommand).toHaveBeenCalledWith(args.emulator, ['button', 'home'])
  })

  it('opens under a grant, revokes, and denies without changing terminal output', async () => {
    const operations = createOperations()

    await expect(verifyHostedIosPhotoPermissionRevocation(args, operations)).resolves.toEqual({
      evidence: {
        grantedAttachControlPoint: { x: 0.75, y: 0.9 },
        grantPrivateOriginRotated: true,
        grantPermissionPrompt: 'not-shown',
        grantSessionRecovery: 'session-retained',
        grantWorkspaceAuthorityRotated: true,
        interruptionPrivateOrigin: 'retained',
        interruptionSessionRecovery: 'session-retained',
        interruptionWorkspaceAuthority: 'retained',
        permissionState: 'revoked-after-grant',
        pickerInterruption: 'resumed-then-cancelled',
        pickerCancelControl: { label: 'Cancel', x: 0.9, y: 0.1 },
        privilegedPageMarkers: 'absent',
        revokedAttachControlPoint: { x: 0.75, y: 0.9 },
        revocationPrivateOriginRotated: true,
        revocationSessionRecovery: 'session-retained',
        revocationWorkspaceAuthorityRotated: true,
        route: revokedDocument.href,
        routeRestored: true,
        resumedPickerControl: { label: 'Cancel', x: 0.9, y: 0.1 },
        terminalOutput: 'unchanged',
        toast: 'Photo permission denied'
      },
      sessionDocument: revokedDocument
    })
    expect(operations.grantPermission).toHaveBeenCalledWith('simulator')
    expect(operations.revokePermission).toHaveBeenCalledWith('simulator')
    expect(operations.backgroundApp).toHaveBeenCalledOnce()
    expect(operations.backgroundApp).toHaveBeenCalledWith(args.emulator)
    expect(operations.waitForPickerDismissal).toHaveBeenCalledWith(args.emulator, 'Cancel', 5_000)
    expect(operations.launchApp).toHaveBeenCalledTimes(3)
    expect(operations.dismissDeveloperMenu).toHaveBeenCalledTimes(3)
    expect(operations.tapControl).toHaveBeenNthCalledWith(
      1,
      args.emulator,
      'Attach a photo',
      args.timeoutMs
    )
    expect(operations.tapControl).toHaveBeenNthCalledWith(
      2,
      args.emulator,
      'Attach a photo',
      args.timeoutMs
    )
    expect(operations.waitForControl).toHaveBeenCalledWith(
      args.emulator,
      ['Cancel', 'Allow Full Access'],
      10_000
    )
    expect(operations.waitForControl).toHaveBeenCalledWith(args.emulator, ['Cancel'], 5_000)
    expect(operations.readTerminal).toHaveBeenCalledTimes(2)
  })

  it('rejects privileged page markers after revocation', async () => {
    const operations = createOperations()
    operations.readState.mockResolvedValue({
      bodyText: 'Photo permission denied\norca-paste-secret.png'
    })

    await expect(verifyHostedIosPhotoPermissionRevocation(args, operations)).rejects.toThrow(
      'exposed privileged page marker: orca-paste-'
    )
  })

  it('accepts the real full-access prompt before cancelling the granted picker', async () => {
    const operations = createOperations()
    operations.waitForControl
      .mockResolvedValueOnce({ label: 'Allow Full Access', x: 0.5, y: 0.7 })
      .mockResolvedValueOnce({ label: 'Cancel', x: 0.9, y: 0.1 })

    const result = await verifyHostedIosPhotoPermissionRevocation(args, operations)

    expect(result.evidence.grantPermissionPrompt).toBe('allowed-full-access')
    expect(operations.tapPoint).toHaveBeenNthCalledWith(1, args.emulator, {
      label: 'Allow Full Access',
      x: 0.5,
      y: 0.7
    })
    expect(operations.tapPoint).toHaveBeenNthCalledWith(2, args.emulator, {
      label: 'Cancel',
      x: 0.9,
      y: 0.1
    })
    expect(operations.backgroundApp).toHaveBeenCalledWith(args.emulator)
  })

  it('rejects a private origin reused across the grant restart', async () => {
    const operations = createOperations()
    operations.waitForDocument.mockReset().mockResolvedValue(args.sessionDocument)

    await expect(verifyHostedIosPhotoPermissionRevocation(args, operations)).rejects.toThrow(
      'grant reused the private WebView origin'
    )
  })

  it('rejects a private origin reused across the revocation restart', async () => {
    const operations = createOperations()
    operations.waitForDocument
      .mockReset()
      .mockResolvedValueOnce(grantedDocument)
      .mockResolvedValueOnce(grantedDocument)
      .mockResolvedValueOnce(grantedDocument)

    await expect(verifyHostedIosPhotoPermissionRevocation(args, operations)).rejects.toThrow(
      'revocation reused the private WebView origin'
    )
  })

  it('rejects private origin replacement across picker interruption', async () => {
    const operations = createOperations()
    const replacedOrigin = {
      href: grantedDocument.href.replace('://grant-restart/', '://interruption-restart/')
    }
    operations.waitForDocument
      .mockReset()
      .mockResolvedValueOnce(grantedDocument)
      .mockResolvedValueOnce(replacedOrigin)

    await expect(verifyHostedIosPhotoPermissionRevocation(args, operations)).rejects.toThrow(
      'picker interruption authority did not match session-retained recovery'
    )
  })

  it('rejects opaque authority replacement across picker interruption', async () => {
    const operations = createOperations()
    const replacedAuthority = {
      href: grantedDocument.href.replace('/grant-workspace', '/interrupted-workspace')
    }
    operations.waitForDocument
      .mockReset()
      .mockResolvedValueOnce(grantedDocument)
      .mockResolvedValueOnce(replacedAuthority)

    await expect(verifyHostedIosPhotoPermissionRevocation(args, operations)).rejects.toThrow(
      'picker interruption authority did not match session-retained recovery'
    )
  })

  it('requires rotated authority when picker interruption needs route handoff', async () => {
    const operations = createOperations()
    const workspaceDocument = { href: 'orca-mobile-web://workspace/h/host' }
    const interruptedDocument = {
      href: grantedDocument.href
        .replace('://grant-restart/', '://interruption-restart/')
        .replace('/grant-workspace', '/interrupted-workspace')
    }
    operations.waitForDocument
      .mockReset()
      .mockResolvedValueOnce(grantedDocument)
      .mockRejectedValueOnce(new Error('session not retained'))
      .mockResolvedValueOnce(workspaceDocument)
      .mockResolvedValueOnce(interruptedDocument)
      .mockResolvedValueOnce(revokedDocument)

    const result = await verifyHostedIosPhotoPermissionRevocation(args, operations)

    expect(result.evidence).toMatchObject({
      interruptionPrivateOrigin: 'rotated',
      interruptionSessionRecovery: 'hybrid-route-handoff',
      interruptionWorkspaceAuthority: 'rotated'
    })
  })

  it('skips row activation when the hybrid route restores the session itself', async () => {
    const operations = createOperations()
    operations.waitForDocument
      .mockReset()
      .mockRejectedValueOnce(new Error('session not retained'))
      .mockResolvedValueOnce(grantedDocument)
      .mockResolvedValueOnce(grantedDocument)
      .mockResolvedValueOnce(grantedDocument)
      .mockResolvedValueOnce(revokedDocument)

    const result = await verifyHostedIosPhotoPermissionRevocation(args, operations)

    expect(result.evidence).toMatchObject({ grantSessionRecovery: 'hybrid-route-handoff' })
    expect(operations.openHybridRoute).toHaveBeenCalledOnce()
    expect(operations.activateWorkspace).not.toHaveBeenCalled()
  })

  it('reopens the production hybrid route after permission-triggered termination', async () => {
    const operations = createOperations()
    const workspaceDocument = { href: 'orca-mobile-web://workspace/h/host' }
    operations.waitForDocument
      .mockReset()
      .mockRejectedValueOnce(new Error('session not retained'))
      .mockResolvedValueOnce(workspaceDocument)
      .mockResolvedValueOnce(grantedDocument)
      .mockResolvedValueOnce(grantedDocument)
      .mockRejectedValueOnce(new Error('session not retained'))
      .mockResolvedValueOnce(workspaceDocument)
      .mockResolvedValueOnce(revokedDocument)

    const result = await verifyHostedIosPhotoPermissionRevocation(args, operations)

    expect(result.evidence).toMatchObject({
      grantSessionRecovery: 'hybrid-route-handoff',
      interruptionSessionRecovery: 'session-retained',
      revocationSessionRecovery: 'hybrid-route-handoff',
      routeRestored: true
    })
    expect(operations.openHybridRoute).toHaveBeenCalledTimes(2)
    expect(operations.openHybridRoute).toHaveBeenCalledWith(args.emulator, args.timeoutMs)
    expect(operations.activateWorkspace).toHaveBeenCalledTimes(2)
    expect(operations.activateWorkspace).toHaveBeenCalledWith(
      workspaceDocument,
      args.expectedWorkspace,
      expect.any(Function),
      args.timeoutMs,
      expect.any(Function)
    )
  })

  it('rejects terminal mutations after revocation', async () => {
    const operations = createOperations()
    operations.readTerminal
      .mockResolvedValueOnce(['ORCA_HOSTED_CLIPBOARD_TEXT_PASTE'])
      .mockResolvedValueOnce(['ORCA_HOSTED_CLIPBOARD_TEXT_PASTE', '/tmp/orca-paste-private.png'])

    await expect(verifyHostedIosPhotoPermissionRevocation(args, operations)).rejects.toThrow(
      'changed the Desktop terminal'
    )
  })
})
