import { app, BrowserWindow } from 'electron'
import { writeFile, unlink } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export class ExportTimeoutError extends Error {
  constructor(message = 'Export timed out') {
    super(message)
    this.name = 'ExportTimeoutError'
  }
}

const EXPORT_TIMEOUT_MS = 60_000

// Printing captures the current paint; wait for remote images and image-backed diagrams to load.
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
  const tempDir = app.getPath('temp')
  const tempPath = path.join(tempDir, `orca-export-${randomUUID()}.html`)

  // Exclusive creation prevents writing through pre-seated symlinks; EEXIST paths belong to someone else.
  try {
    await writeFile(tempPath, html, { encoding: 'utf-8', flag: 'wx' })
  } catch (error) {
    if (isAlreadyExists(error)) {
      throw error
    }
    await removeOwnTempDocument(tempPath)
    throw error
  }

  try {
    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        // Image readiness probes and exported scripts/SVGs need JavaScript within the sandboxed, isolated renderer.
        javascript: true
      }
    })

    let timer: NodeJS.Timeout | undefined

    try {
      // Bound loading too: a non-yielding document script never fires load completion or failure.
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ExportTimeoutError()), EXPORT_TIMEOUT_MS)
      })

      const loadAndPrint = (async (): Promise<Buffer> => {
        const loadPromise = new Promise<void>((resolve, reject) => {
          win.webContents.once('did-finish-load', () => resolve())
          win.webContents.once('did-fail-load', (_event, errorCode, errorDescription) => {
            reject(new Error(`Failed to load export document: ${errorDescription} (${errorCode})`))
          })
        })

        await win.loadFile(tempPath)
        await loadPromise
        await win.webContents.executeJavaScript(WAIT_FOR_IMAGES_SCRIPT, true)
        return win.webContents.printToPDF({
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

      return await Promise.race([loadAndPrint, timeoutPromise])
    } finally {
      if (timer) {
        clearTimeout(timer)
      }
      if (!win.isDestroyed()) {
        win.destroy()
      }
    }
  } finally {
    await removeOwnTempDocument(tempPath)
  }
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST'
}

// unlink removes the entry without following a symlink swapped in by another process.
async function removeOwnTempDocument(tempPath: string): Promise<void> {
  try {
    await unlink(tempPath)
  } catch {
    // Best-effort temp cleanup must not turn successful export into failure.
  }
}
