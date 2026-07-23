import { describe, expect, it, vi } from 'vitest'
import {
  acquireBrowserPdfAdmission,
  BROWSER_PDF_MAX_CONCURRENT_PRINTS,
  startBrowserPdfPrint
} from './browser-pdf-admission'

function createWebContents() {
  return { printToPDF: vi.fn<() => Promise<Buffer>>() }
}

describe('browser PDF admission', () => {
  it('caps native prints process-wide and releases only after native settlement', async () => {
    const resolvers: ((data: Buffer) => void)[] = []
    const webContents = createWebContents()
    webContents.printToPDF.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve)
        })
    )

    const active = Array.from({ length: BROWSER_PDF_MAX_CONCURRENT_PRINTS }, () =>
      startBrowserPdfPrint(webContents as never, {})
    )
    expect(active.every(Boolean)).toBe(true)
    expect(startBrowserPdfPrint(createWebContents() as never, {})).toBeNull()

    resolvers[0]!(Buffer.from('first'))
    await Promise.resolve()
    const nextWebContents = createWebContents()
    nextWebContents.printToPDF.mockResolvedValue(Buffer.from('next'))
    await expect(startBrowserPdfPrint(nextWebContents as never, {})).resolves.toEqual(
      Buffer.from('next')
    )

    resolvers[1]!(Buffer.from('second'))
    await Promise.all(active)
  })

  it('lets pre-render work release unused admission', () => {
    const first = acquireBrowserPdfAdmission()
    const second = acquireBrowserPdfAdmission()
    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    expect(acquireBrowserPdfAdmission()).toBeNull()

    first!.releaseIfIdle()
    const replacement = acquireBrowserPdfAdmission()
    expect(replacement).not.toBeNull()
    second!.releaseIfIdle()
    replacement!.releaseIfIdle()
  })

  it('releases process-wide print slots after synchronous and asynchronous failures', async () => {
    const synchronous = createWebContents()
    synchronous.printToPDF.mockImplementation(() => {
      throw new Error('sync print failure')
    })
    await expect(startBrowserPdfPrint(synchronous as never, {})).rejects.toThrow(
      'sync print failure'
    )

    const asynchronous = createWebContents()
    asynchronous.printToPDF.mockRejectedValue(new Error('async print failure'))
    await expect(startBrowserPdfPrint(asynchronous as never, {})).rejects.toThrow(
      'async print failure'
    )

    const replacement = createWebContents()
    replacement.printToPDF.mockResolvedValue(Buffer.from('replacement'))
    await expect(startBrowserPdfPrint(replacement as never, {})).resolves.toEqual(
      Buffer.from('replacement')
    )
  })
})
