import { app, BrowserWindow } from 'electron'
import { writeFile, unlink } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  acquireBrowserPdfAdmission,
  BROWSER_PDF_BUSY_ERROR
} from '../browser/browser-pdf-admission'
import { assertCdpPdfWithinMemoryLimit } from '../browser/cdp-print-to-pdf'
import { assertHtmlToPdfInputWithinMemoryLimit } from './html-to-pdf-memory-limit'

export class ExportTimeoutError extends Error {
  constructor(message = 'Export timed out') {
    super(message)
    this.name = 'ExportTimeoutError'
  }
}

const EXPORT_TIMEOUT_MS = 60_000

// Why: injected into the hidden export window so printToPDF does not fire while
// <img> elements are still fetching. printToPDF renders whatever is painted at
// the moment it runs; without this gate, remote images and Mermaid SVGs loaded
// via <img> can be missing from the output.
const WAIT_FOR_IMAGES_SCRIPT = `
new Promise((resolve) => {
  const imgs = Array.from(document.images || [])
  if (imgs.length === 0) { resolve(); return }
  let remaining = imgs.length
  const done = () => { remaining -= 1; if (remaining <= 0) resolve() }
  imgs.forEach((img) => {
    if (img.complete) { done(); return }
    img.addEventListener('load', done, { once: true })
    img.addEventListener('error', done, { once: true })
  })
})
`

export async function htmlToPdf(html: string): Promise<Buffer> {
  assertHtmlToPdfInputWithinMemoryLimit(html)
  const tempDir = app.getPath('temp')
  const tempPath = path.join(tempDir, `orca-export-${randomUUID()}.html`)
  const pdfAdmission = acquireBrowserPdfAdmission()
  if (!pdfAdmission) {
    throw new Error(BROWSER_PDF_BUSY_ERROR)
  }
  let win: BrowserWindow | null = null
  let timer: NodeJS.Timeout | undefined

  try {
    await writeFile(tempPath, html, 'utf-8')
    win = new BrowserWindow({
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        // Why: image-wait needs script execution to finish remote images and rendered SVGs.
        javascript: true
      }
    })
    const exportWindow = win
    const loadPromise = new Promise<void>((resolve, reject) => {
      exportWindow.webContents.once('did-finish-load', () => resolve())
      exportWindow.webContents.once('did-fail-load', (_event, errorCode, errorDescription) => {
        reject(new Error(`Failed to load export document: ${errorDescription} (${errorCode})`))
      })
    })

    await exportWindow.loadFile(tempPath)
    await loadPromise

    const renderAndPrint = (async (): Promise<Buffer> => {
      await exportWindow.webContents.executeJavaScript(WAIT_FOR_IMAGES_SCRIPT, true)
      return pdfAdmission.print(exportWindow.webContents, {
        printBackground: true,
        pageSize: 'A4',
        margins: {
          top: 0.75,
          bottom: 0.75,
          left: 0.75,
          right: 0.75
        }
      })
    })()

    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new ExportTimeoutError()), EXPORT_TIMEOUT_MS)
    })

    const pdf = await Promise.race([renderAndPrint, timeoutPromise])
    assertCdpPdfWithinMemoryLimit(pdf)
    return pdf
  } finally {
    pdfAdmission.releaseIfIdle()
    if (timer) {
      clearTimeout(timer)
    }
    if (win && !win.isDestroyed()) {
      win.destroy()
    }
    try {
      await unlink(tempPath)
    } catch {
      // Why: best-effort cleanup — losing the temp file should not surface
      // as a user-facing export failure.
    }
  }
}
