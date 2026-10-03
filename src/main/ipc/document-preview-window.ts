import { ipcMain } from 'electron'
import {
  HtmlPreviewWindowSchema,
  MarkdownPreviewWindowSchema
} from '../../shared/document-preview-window'
import { openHtmlPreviewWindow, openMarkdownPreviewWindow } from '../window/document-preview-window'
import { isTrustedUIRenderer } from './ui'

export function registerDocumentPreviewWindowHandlers(): void {
  ipcMain.handle('docPreview:openMarkdownWindow', async (event, request: unknown) => {
    if (!isTrustedUIRenderer(event.sender)) {
      throw new Error('Untrusted document window request')
    }
    await openMarkdownPreviewWindow(MarkdownPreviewWindowSchema.parse(request))
  })
  ipcMain.handle('docPreview:openHtmlWindow', async (event, request: unknown) => {
    if (!isTrustedUIRenderer(event.sender)) {
      throw new Error('Untrusted document window request')
    }
    await openHtmlPreviewWindow(HtmlPreviewWindowSchema.parse(request).grantId, event.sender)
  })
}
