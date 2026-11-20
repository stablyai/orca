import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserManager } from '../browser-manager'
import { installDocPreviewGuestPolicy } from '../../../document-preview/doc-preview-guest-policy'
import {
  mintDocPreviewGrant,
  revokeAllDocPreviewGrants
} from '../../../document-preview/doc-preview-grant-registry'
import { buildDocPreviewUrl } from '../../../../../shared/document-preview/doc-preview-scheme'

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: () => null },
  WebContentsView: class {},
  app: { getPath: () => '/downloads' },
  clipboard: { writeText: vi.fn() },
  shell: { openExternal: vi.fn() },
  Menu: { buildFromTemplate: vi.fn() },
  screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }) },
  webContents: { fromId: () => null }
}))

afterEach(() => revokeAllDocPreviewGrants())

describe('palette footprint ownership', () => {
  it('rejects another renderer clearing a footprint, including after guest loss, while its owner can still clear it', () => {
    const manager = new BrowserManager()
    const grant = mintDocPreviewGrant({
      owner: { kind: 'ssh', connectionId: 'synthetic-host' },
      root: '/synthetic/docs',
      entryRelativePath: 'index.html',
      browserPageId: 'preview-page'
    })
    let destroyed = false
    const guest = Object.assign(new EventEmitter(), {
      isDestroyed: () => destroyed,
      getURL: () => buildDocPreviewUrl(grant.id, 'index.html'),
      setWindowOpenHandler: () => {},
      setWebRTCIPHandlingPolicy: () => {},
      executeJavaScript: async () => true
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the document policy and footprint delivery only use the members above.
    const contents = guest as unknown as Electron.WebContents
    const dispose = installDocPreviewGuestPolicy(contents, { id: 17, send: () => {} })
    try {
      expect(
        manager.setGrabLabelAvoidArea(
          'preview-page',
          { x: 10, y: 20, width: 100, height: 40, frameWidth: 640, frameHeight: 480 },
          17
        )
      ).toBe(true)
      expect(manager.setGrabLabelAvoidArea('preview-page', null, 23)).toBe(false)

      destroyed = true
      guest.emit('destroyed')

      expect(manager.setGrabLabelAvoidArea('preview-page', null, 23)).toBe(false)
      expect(manager.setGrabLabelAvoidArea('preview-page', null, 17)).toBe(true)
    } finally {
      dispose()
    }
  })
})
