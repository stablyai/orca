import { BrowserWindow, dialog, ipcMain } from 'electron'
import { writeFile } from 'node:fs/promises'
import { ExportTimeoutError, htmlToPdf } from '../lib/html-to-pdf'
import { abortWhenRendererGone } from './renderer-lifetime-abort'
import { pdfExportFailure, type PdfExportResult } from '../../shared/pdf-export-failure-copy'

export type ExportHtmlToPdfArgs = {
  html: string
  title: string
}

export type ExportHtmlToPdfResult = PdfExportResult

export function registerExportHandlers(): void {
  ipcMain.removeHandler('export:html-to-pdf')
  ipcMain.handle(
    'export:html-to-pdf',
    async (event, args: ExportHtmlToPdfArgs): Promise<ExportHtmlToPdfResult> => {
      const { html, title } = args
      if (!html.trim()) {
        return pdfExportFailure('noContent')
      }

      const lifetime = abortWhenRendererGone(event.sender)
      try {
        const pdfBuffer = await htmlToPdf(html, lifetime.signal)
        lifetime.signal.throwIfAborted()

        // Keep long titles and Windows-forbidden characters out of suggested save filenames.
        const sanitizedTitle = title.replace(/[/\\:*?"<>|]/g, '_').slice(0, 100) || 'export'
        const defaultFilename = `${sanitizedTitle}.pdf`

        const parent = BrowserWindow.fromWebContents(event.sender) ?? undefined
        const dialogOptions = {
          defaultPath: defaultFilename,
          filters: [{ name: 'PDF', extensions: ['pdf'] }]
        }
        const { canceled, filePath } = parent
          ? await dialog.showSaveDialog(parent, dialogOptions)
          : await dialog.showSaveDialog(dialogOptions)

        lifetime.signal.throwIfAborted()
        if (canceled || !filePath) {
          return { success: false, cancelled: true }
        }

        lifetime.dispose()
        await writeFile(filePath, pdfBuffer)
        return { success: true, filePath }
      } catch (error) {
        if (lifetime.signal.aborted) {
          return { success: false, cancelled: true }
        }
        if (error instanceof ExportTimeoutError) {
          return pdfExportFailure('timedOut')
        }
        return error instanceof Error
          ? { success: false, error: error.message }
          : pdfExportFailure('failed')
      } finally {
        lifetime.dispose()
      }
    }
  )
}
