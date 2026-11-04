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

const TEXT_EXPORT_MAX_BYTES = 20_000_000
const TEXT_EXPORT_EXTENSIONS = new Set(['json', 'csv'])

/** Write renderer-built text only where the user picks in the native dialog. */
function registerTextFileExport(): void {
  ipcMain.removeHandler('export:save-text-file')
  ipcMain.handle(
    'export:save-text-file',
    async (
      event,
      args: { text: unknown; suggestedName: unknown; extension: unknown }
    ): Promise<{ saved: boolean; filePath?: string; error?: string }> => {
      const { text, suggestedName, extension } = args ?? {}
      if (typeof text !== 'string' || typeof suggestedName !== 'string') {
        return { saved: false, error: 'Nothing to export.' }
      }
      if (typeof extension !== 'string' || !TEXT_EXPORT_EXTENSIONS.has(extension)) {
        return { saved: false, error: 'Unsupported export format.' }
      }
      if (Buffer.byteLength(text, 'utf8') > TEXT_EXPORT_MAX_BYTES) {
        return { saved: false, error: 'The export is larger than 20 MB.' }
      }
      const name = suggestedName.replace(/[/\\:*?"<>|]/g, '_').slice(0, 100) || 'export'
      const options = {
        defaultPath: `${name}.${extension}`,
        filters: [{ name: extension.toUpperCase(), extensions: [extension] }]
      }
      const parent = BrowserWindow.fromWebContents(event.sender) ?? undefined
      const { canceled, filePath } = parent
        ? await dialog.showSaveDialog(parent, options)
        : await dialog.showSaveDialog(options)
      if (canceled || !filePath) {
        return { saved: false }
      }
      await writeFile(filePath, text, 'utf8')
      return { saved: true, filePath }
    }
  )
}

export function registerExportHandlers(): void {
  registerTextFileExport()
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
