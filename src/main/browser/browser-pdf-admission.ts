import type { PrintToPDFOptions, WebContents } from 'electron'

export const BROWSER_PDF_MAX_CONCURRENT_PRINTS = 2
export const BROWSER_PDF_BUSY_ERROR = 'Too many PDF print requests are already running'

let activePrints = 0

export type BrowserPdfAdmission = {
  print(webContents: WebContents, options: PrintToPDFOptions): Promise<Buffer>
  releaseIfIdle(): void
}

export function acquireBrowserPdfAdmission(): BrowserPdfAdmission | null {
  if (activePrints >= BROWSER_PDF_MAX_CONCURRENT_PRINTS) {
    return null
  }
  activePrints += 1
  let printStarted = false
  let released = false
  const release = (): void => {
    if (released) {
      return
    }
    released = true
    activePrints = Math.max(0, activePrints - 1)
  }

  return {
    print(webContents, options) {
      if (printStarted) {
        return Promise.reject(new Error('PDF admission has already started a print'))
      }
      printStarted = true
      let print: Promise<Buffer>
      try {
        print = webContents.printToPDF(options)
      } catch (error) {
        release()
        return Promise.reject(error)
      }
      // Why: native PDF work cannot be cancelled when its caller times out or disconnects.
      void print.then(release, release)
      return print
    },
    releaseIfIdle() {
      if (!printStarted) {
        release()
      }
    }
  }
}

export function startBrowserPdfPrint(
  webContents: WebContents,
  options: PrintToPDFOptions
): Promise<Buffer> | null {
  const admission = acquireBrowserPdfAdmission()
  return admission?.print(webContents, options) ?? null
}
