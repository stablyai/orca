import { describe, expect, it, vi } from 'vitest'
import { registerDocumentPreviewWindowHandlers } from './document-preview-window'

type Handler = (event: { sender: object }, request: unknown) => Promise<void>
const mocks = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  trusted: false,
  openMarkdown: vi.fn(),
  openHtml: vi.fn()
}))
vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, handler: Handler) => mocks.handlers.set(name, handler) }
}))
vi.mock('./ui', () => ({ isTrustedUIRenderer: () => mocks.trusted }))
vi.mock('../window/document-preview-window', () => ({
  openMarkdownPreviewWindow: mocks.openMarkdown,
  openHtmlPreviewWindow: mocks.openHtml
}))

describe('document window admission', () => {
  it('denies guests and rejects malformed requests before creating a native window', async () => {
    registerDocumentPreviewWindowHandlers()
    const event = { sender: {} }
    const open = mocks.handlers.get('docPreview:openHtmlWindow')!
    await expect(open(event, { grantId: 'a'.repeat(32) })).rejects.toThrow('Untrusted')
    mocks.trusted = true
    await expect(open(event, { grantId: '../private' })).rejects.toThrow()
    await expect(open(event, { grantId: 'a'.repeat(32), preload: '/secret' })).rejects.toThrow()
    expect(mocks.openHtml).not.toHaveBeenCalled()
    const markdown = mocks.handlers.get('docPreview:openMarkdownWindow')!
    await expect(markdown(event, { fileId: 'file', title: 'Title', html: '' })).rejects.toThrow()
    expect(mocks.openMarkdown).not.toHaveBeenCalled()
    await open(event, { grantId: 'a'.repeat(32) })
    expect(mocks.openHtml).toHaveBeenCalledWith('a'.repeat(32), event.sender)
  })
})
