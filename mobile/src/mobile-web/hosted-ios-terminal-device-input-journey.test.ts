import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  verifyClipboardImagePaste: vi.fn(),
  verifyDocumentUpload: vi.fn(),
  verifyClipboardPaste: vi.fn(),
  verifyPhotoDenial: vi.fn(),
  verifyPhotoRevocation: vi.fn()
}))

vi.mock('../../scripts/hosted-ios-document-upload.mjs', () => ({
  verifyHostedIosDocumentUpload: mocks.verifyDocumentUpload
}))
vi.mock('../../scripts/hosted-ios-terminal-clipboard-paste.mjs', () => ({
  verifyHostedIosTerminalClipboardPaste: mocks.verifyClipboardPaste
}))
vi.mock('../../scripts/hosted-ios-terminal-clipboard-image-paste.mjs', () => ({
  verifyHostedIosTerminalClipboardImagePaste: mocks.verifyClipboardImagePaste
}))
vi.mock('../../scripts/hosted-ios-photo-permission-denial.mjs', () => ({
  verifyHostedIosPhotoPermissionDenial: mocks.verifyPhotoDenial
}))
vi.mock('../../scripts/hosted-ios-photo-permission-revocation.mjs', () => ({
  verifyHostedIosPhotoPermissionRevocation: mocks.verifyPhotoRevocation
}))

import {
  verifyHostedIosTerminalDeviceInputJourney,
  verifyHostedIosTerminalInputJourney
} from '../../scripts/hosted-ios-terminal-device-input-journey.mjs'

describe('hosted iOS terminal device-input journey', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('carries the exact session and terminal through every device-input operation', async () => {
    const args = {
      deviceUdid: 'simulator',
      emulator: {},
      worktree: '/repo/mobile-rearch',
      workspaceDocument: { href: 'workspace' }
    }
    const documentFixture = {
      destinationPath: '/simulator/fixture.png',
      fixtureName: 'fixture.png'
    }
    const seedFixture = vi.fn().mockResolvedValue(documentFixture)
    const removeFixture = vi.fn().mockResolvedValue(undefined)
    const terminalClipboardPaste = {
      evidence: { terminalHandle: 'terminal-handle' },
      sessionDocument: { href: 'session' }
    }
    const photoPermissionDenial = {
      evidence: { toast: 'Photo permission denied' },
      sessionDocument: { href: 'session-after-photo-denial' }
    }
    const photoPermissionRevocation = {
      evidence: { permissionState: 'revoked-after-grant' },
      sessionDocument: { href: 'session-after-photo-revocation' }
    }
    const documentUpload = {
      evidence: { terminalPathInjected: true },
      sessionDocument: { href: 'session-after-document-upload' }
    }
    const terminalClipboardImagePaste = {
      evidence: { terminalPathInjected: true },
      sessionDocument: { href: 'session-after-clipboard-image-paste' }
    }
    mocks.verifyClipboardPaste.mockResolvedValue(terminalClipboardPaste)
    mocks.verifyClipboardImagePaste.mockResolvedValue(terminalClipboardImagePaste)
    mocks.verifyPhotoDenial.mockResolvedValue(photoPermissionDenial)
    mocks.verifyPhotoRevocation.mockResolvedValue(photoPermissionRevocation)
    mocks.verifyDocumentUpload.mockResolvedValue(documentUpload)

    await expect(
      verifyHostedIosTerminalDeviceInputJourney(args, {
        removeFixture,
        seedFixture
      })
    ).resolves.toEqual({
      documentUpload,
      photoPermissionDenial,
      photoPermissionRevocation,
      terminalClipboardImagePaste,
      terminalClipboardPaste
    })
    expect(seedFixture).toHaveBeenCalledWith({
      deviceUdid: 'simulator',
      fixturePath: '/repo/mobile-rearch/mobile/assets/favicon.png'
    })
    expect(mocks.verifyPhotoDenial).toHaveBeenCalledWith({
      ...args,
      sessionDocument: documentUpload.sessionDocument,
      terminalHandle: 'terminal-handle'
    })
    expect(mocks.verifyDocumentUpload).toHaveBeenCalledWith({
      ...args,
      documentFixture,
      sessionDocument: terminalClipboardPaste.sessionDocument,
      terminalHandle: 'terminal-handle'
    })
    expect(mocks.verifyPhotoRevocation).toHaveBeenCalledWith({
      ...args,
      sessionDocument: photoPermissionDenial.sessionDocument,
      terminalHandle: 'terminal-handle'
    })
    expect(mocks.verifyClipboardImagePaste).toHaveBeenCalledWith({
      ...args,
      sessionDocument: photoPermissionRevocation.sessionDocument,
      terminalHandle: 'terminal-handle'
    })
    expect(removeFixture).toHaveBeenCalledWith(documentFixture.destinationPath)
  })

  it('runs clipboard-image verification without unrelated picker stages', async () => {
    const args = {
      deviceUdid: 'simulator',
      emulator: {},
      worktree: '/repo/mobile-rearch',
      workspaceDocument: { href: 'workspace' }
    }
    const terminalClipboardPaste = {
      evidence: { terminalHandle: 'terminal-handle' },
      sessionDocument: { href: 'session' }
    }
    const terminalClipboardImagePaste = {
      evidence: { terminalPathInjected: true },
      sessionDocument: { href: 'session-after-image-paste' }
    }
    mocks.verifyClipboardPaste.mockResolvedValue(terminalClipboardPaste)
    mocks.verifyClipboardImagePaste.mockResolvedValue(terminalClipboardImagePaste)

    await expect(
      verifyHostedIosTerminalInputJourney(args, { clipboardImageOnly: true })
    ).resolves.toEqual({
      terminalClipboardImagePaste,
      terminalClipboardPaste
    })
    expect(mocks.verifyClipboardImagePaste).toHaveBeenCalledWith({
      ...args,
      sessionDocument: terminalClipboardPaste.sessionDocument,
      terminalHandle: 'terminal-handle'
    })
    expect(mocks.verifyDocumentUpload).not.toHaveBeenCalled()
    expect(mocks.verifyPhotoDenial).not.toHaveBeenCalled()
    expect(mocks.verifyPhotoRevocation).not.toHaveBeenCalled()
  })

  it('runs Photos revocation without unrelated picker stages', async () => {
    const args = {
      deviceUdid: 'simulator',
      emulator: {},
      worktree: '/repo/mobile-rearch',
      workspaceDocument: { href: 'workspace' }
    }
    const terminalClipboardPaste = {
      evidence: { terminalHandle: 'terminal-handle' },
      sessionDocument: { href: 'session' }
    }
    const photoPermissionRevocation = {
      evidence: { permissionState: 'revoked-after-grant' },
      sessionDocument: { href: 'session-after-photo-revocation' }
    }
    mocks.verifyClipboardPaste.mockResolvedValue(terminalClipboardPaste)
    mocks.verifyPhotoRevocation.mockResolvedValue(photoPermissionRevocation)

    await expect(
      verifyHostedIosTerminalInputJourney(args, { photosRevocationOnly: true })
    ).resolves.toEqual({
      photoPermissionRevocation,
      terminalClipboardPaste
    })
    expect(mocks.verifyPhotoRevocation).toHaveBeenCalledWith({
      ...args,
      sessionDocument: terminalClipboardPaste.sessionDocument,
      terminalHandle: 'terminal-handle'
    })
    expect(mocks.verifyDocumentUpload).not.toHaveBeenCalled()
    expect(mocks.verifyPhotoDenial).not.toHaveBeenCalled()
    expect(mocks.verifyClipboardImagePaste).not.toHaveBeenCalled()
  })
})
