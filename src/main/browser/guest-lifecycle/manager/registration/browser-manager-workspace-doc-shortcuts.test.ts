import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'

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

import { buildDocPreviewUrl } from '../../../../../shared/document-preview/doc-preview-scheme'
import {
  mintDocPreviewGrant,
  revokeAllDocPreviewGrants
} from '../../../document-preview/doc-preview-grant-registry'
import {
  DestroyedGuestTestContents,
  DestroyedGuestTestManager
} from './browser-manager-destroyed-guest-test-fixture'

describe('workspace document guest input', () => {
  const guests: DestroyedGuestTestContents[] = []

  function attachDocumentGuest(): {
    guest: DestroyedGuestTestContents
    send: Mock
  } {
    const grant = mintDocPreviewGrant({
      owner: {
        kind: 'runtime',
        environmentId: 'env-1',
        worktreeSelector: 'id:worktree-1',
        worktreeRoot: '/repo'
      },
      root: '/repo',
      entryRelativePath: 'page.html',
      browserPageId: 'doc-page-1'
    })
    const url = buildDocPreviewUrl(grant.id, grant.entryRelativePath)
    const guest = Object.assign(new DestroyedGuestTestContents(7), { getURL: () => url })
    const send = vi.fn()
    const host = Object.assign(new DestroyedGuestTestContents(5001), { send })
    new DestroyedGuestTestManager().attachGuestPolicies(guest.asWebContents(), null, {
      profile: 'workspace-doc',
      host: host.asWebContents()
    })
    guests.push(guest)
    return { guest, send }
  }

  afterEach(() => {
    for (const guest of guests.splice(0)) {
      guest.destroy()
    }
    revokeAllDocPreviewGrants()
  })

  it('forwards Ctrl+Tab from a focused document preview to its host window', () => {
    const { guest, send } = attachDocumentGuest()
    const input = { shift: false, alt: false, meta: false, isAutoRepeat: false }
    guest.emit(
      'before-input-event',
      { preventDefault: vi.fn() },
      { ...input, type: 'keyDown', key: 'Tab', code: 'Tab', control: true }
    )
    guest.emit(
      'before-input-event',
      { preventDefault: vi.fn() },
      { ...input, type: 'keyUp', key: 'Control', code: 'ControlLeft', control: false }
    )

    expect(send.mock.calls).toEqual([
      ['ui:ctrlTabKeyDown', { shiftKey: false }],
      ['ui:ctrlTabKeyUp']
    ])
  })

  it('reports a press in the preview so its split becomes active', () => {
    const { guest, send } = attachDocumentGuest()
    guest.emit('before-mouse-event', { preventDefault: vi.fn() }, { type: 'mouseDown', x: 1, y: 1 })

    expect(send.mock.calls).toEqual([
      ['ui:browserPagePointerDown', { browserPageId: 'doc-page-1' }]
    ])
  })
})
