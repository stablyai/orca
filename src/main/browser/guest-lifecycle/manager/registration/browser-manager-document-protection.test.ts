import { guestNavigationMethods } from '../browser-manager-test-harness'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/downloads' },
  BrowserWindow: { fromWebContents: () => null },
  clipboard: { writeText: vi.fn() },
  shell: { openExternal: vi.fn() },
  Menu: { buildFromTemplate: vi.fn() },
  screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }) },
  webContents: { fromId: () => null }
}))
vi.mock('../../popups/presentation/popup-origin-bar-window', () => ({
  openPopupWithOriginBar: vi.fn()
}))

import { BrowserManager } from '../browser-manager'
import { DestroyedGuestTestContents } from './browser-manager-destroyed-guest-test-fixture'
import { buildDocPreviewUrl } from '../../../../../shared/document-preview/doc-preview-scheme'
import { BROWSER_GUEST_PROTECTION_REPORT } from '../../../../../shared/browser/guest-lifecycle/browser-guest-discard-protection'
import { getWorkspaceDocPageGuest } from '../../../document-preview/doc-preview-guest-policy'
import {
  mintDocPreviewGrant,
  revokeAllDocPreviewGrants
} from '../../../document-preview/doc-preview-grant-registry'

class DocumentGuest extends DestroyedGuestTestContents {
  readonly mainFrame = { frames: [], send: vi.fn<(channel: string, generation: string) => void>() }
  readonly navigationHistory = { ...guestNavigationMethods().navigationHistory, length: () => 1 }
  audible = true

  constructor(
    id: number,
    private readonly url: string
  ) {
    super(id)
  }
  override getURL(): string {
    return this.url
  }
  override isCurrentlyAudible(): boolean {
    return this.audible
  }
  isCrashed(): boolean {
    return false
  }
  setWebRTCIPHandlingPolicy(): void {}

  ready(): void {
    this.emit('dom-ready')
    this.emit(
      'ipc-message',
      { sender: this, senderFrame: this.mainFrame },
      BROWSER_GUEST_PROTECTION_REPORT,
      {
        generation: this.mainFrame.send.mock.lastCall?.[1],
        dirty: false
      }
    )
  }
}

afterEach(() => revokeAllDocPreviewGrants())

it('protects document audio privately and retires the old owner without adding tab audio state', () => {
  const manager = new BrowserManager()
  const send = vi.fn()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Document policy publication reads only this host identity, liveness and send method.
  const host = { id: 42, isDestroyed: () => false, send } as unknown as Electron.WebContents
  const guests: DocumentGuest[] = []
  const attach = (id: number): DocumentGuest => {
    const grant = mintDocPreviewGrant({
      owner: { kind: 'ssh', connectionId: 'ssh-1' },
      root: '/docs',
      entryRelativePath: 'index.html',
      browserPageId: 'document'
    })
    const guest = new DocumentGuest(id, buildDocPreviewUrl(grant.id, 'index.html'))
    guests.push(guest)
    manager.attachGuestPolicies(guest.asWebContents(), null, { profile: 'workspace-doc', host })
    expect(send).toHaveBeenLastCalledWith('browser:guest-discard-protection-changed', {
      browserPageId: 'document',
      webContentsId: id,
      protection: 'unknown',
      reason: 'observer'
    })
    guest.ready()
    expect(send).toHaveBeenLastCalledWith('browser:guest-discard-protection-changed', {
      browserPageId: 'document',
      webContentsId: id,
      protection: 'protected',
      reason: 'audio'
    })
    return guest
  }
  try {
    const old = attach(7)
    old.audible = false
    old.emit('audio-state-changed', { audible: false })
    expect(send).toHaveBeenLastCalledWith('browser:guest-discard-protection-changed', {
      browserPageId: 'document',
      webContentsId: 7,
      protection: 'protected',
      reason: 'history'
    })
    const replacement = attach(8)
    expect(send.mock.calls.some(([channel]) => channel === 'browser:audio-state-changed')).toBe(
      false
    )
    send.mockClear()
    old.audible = true
    old.emit('audio-state-changed', { audible: true })
    old.destroy()
    expect(send).not.toHaveBeenCalled()
    expect(getWorkspaceDocPageGuest('document', host.id)).toBe(replacement.asWebContents())
    replacement.audible = false
    replacement.emit('audio-state-changed', { audible: false })
    expect(send).toHaveBeenLastCalledWith('browser:guest-discard-protection-changed', {
      browserPageId: 'document',
      webContentsId: 8,
      protection: 'protected',
      reason: 'history'
    })
    replacement.destroy()
    expect(getWorkspaceDocPageGuest('document', host.id)).toBeNull()
    expect(send.mock.calls.some(([channel]) => channel === 'browser:audio-state-changed')).toBe(
      false
    )
  } finally {
    for (const guest of guests) {
      if (!guest.isDestroyed()) {
        guest.destroy()
      }
    }
  }
})
