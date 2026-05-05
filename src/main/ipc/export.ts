import { BrowserWindow, dialog, ipcMain } from 'electron'
import { writeFile } from 'node:fs/promises'
import { ExportTimeoutError, htmlToPdf } from '../lib/html-to-pdf'

export type ExportHtmlToPdfArgs = {
  html: string
  title: string
}

export type ExportHtmlToPdfResult =
  | { success: true; filePath: string }
  | { success: false; cancelled?: boolean; error?: string }

export function registerExportHandlers(): void {
  ipcMain.removeHandler('export:html-to-pdf')
  ipcMain.handle(
    'export:html-to-pdf',
    async (event, args: ExportHtmlToPdfArgs): Promise<ExportHtmlToPdfResult> => {
      const { html, title } = args
      if (!html.trim()) {
        return { success: false, error: 'No content to export' }
      }

      try {
        const pdfBuffer = await htmlToPdf(html)

        // Why: sanitize to keep the suggested filename legal on every platform.
        // Windows forbids /\:*?"<>| in filenames; truncate to keep the OS save
        // dialog stable when titles are pathologically long.
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

        if (canceled || !filePath) {
          return { success: false, cancelled: true }
        }

        await writeFile(filePath, pdfBuffer)
        return { success: true, filePath }
      } catch (error) {
        if (error instanceof ExportTimeoutError) {
          return { success: false, error: 'Export timed out' }
        }
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to export PDF'
        }
      }
    }
  )
}
