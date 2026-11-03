import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'
import type { PdfExportResult } from '../../shared/pdf-export-failure-copy'

export const exportApi = {
  htmlToPdf: (args: { html: string; title: string }): Promise<PdfExportResult> =>
    ipcRenderer.invoke('export:html-to-pdf', args)
} satisfies PreloadApi['export']
