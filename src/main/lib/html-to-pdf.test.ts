import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  BrowserWindowMock,
  destroyMock,
  executeJavaScriptMock,
  loadFileMock,
  printToPDFMock,
  unlinkMock,
  writeFileMock,
  setDidFinishLoad
} = vi.hoisted(() => {
  let didFinishLoad: (() => void) | undefined
  const setDidFinishLoad = (listener: (() => void) | undefined): void => {
    didFinishLoad = listener
  }
  const webContentsOnceMock = vi.fn(
    (event: string, listener: (...args: unknown[]) => void): void => {
      if (event === 'did-finish-load') {
        didFinishLoad = () => listener()
      }
    }
  )
  const executeJavaScriptMock = vi.fn(async () => undefined)
  const printToPDFMock = vi.fn(async () => Buffer.from('%PDF-export'))
  const loadFileMock = vi.fn(async () => {
    didFinishLoad?.()
  })
  const destroyMock = vi.fn()
  const exportWindow = {
    webContents: {
      once: webContentsOnceMock,
      executeJavaScript: executeJavaScriptMock,
      printToPDF: printToPDFMock
    },
    loadFile: loadFileMock,
    isDestroyed: vi.fn(() => false),
    destroy: destroyMock
  }
  return {
    BrowserWindowMock: vi.fn(function () {
      return exportWindow
    }),
    destroyMock,
    executeJavaScriptMock,
    loadFileMock,
    printToPDFMock,
    unlinkMock: vi.fn(async () => undefined),
    writeFileMock: vi.fn(async () => undefined),
    setDidFinishLoad
  }
})

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp') },
  BrowserWindow: BrowserWindowMock
}))
vi.mock('node:fs/promises', () => ({ writeFile: writeFileMock, unlink: unlinkMock }))
vi.mock('node:crypto', () => ({ randomUUID: vi.fn(() => 'test-id') }))

import { htmlToPdf } from './html-to-pdf'

describe('htmlToPdf', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setDidFinishLoad(undefined)
    printToPDFMock.mockResolvedValue(Buffer.from('%PDF-export'))
  })

  it('preserves ordinary export rendering and cleanup under the memory admission', async () => {
    await expect(htmlToPdf('<html><body>Hello</body></html>')).resolves.toEqual(
      Buffer.from('%PDF-export')
    )

    expect(writeFileMock).toHaveBeenCalledWith(
      '/tmp/orca-export-test-id.html',
      '<html><body>Hello</body></html>',
      'utf-8'
    )
    expect(loadFileMock).toHaveBeenCalledWith('/tmp/orca-export-test-id.html')
    expect(executeJavaScriptMock).toHaveBeenCalledOnce()
    expect(printToPDFMock).toHaveBeenCalledWith({
      printBackground: true,
      pageSize: 'A4',
      margins: { top: 0.75, bottom: 0.75, left: 0.75, right: 0.75 }
    })
    expect(destroyMock).toHaveBeenCalledOnce()
    expect(unlinkMock).toHaveBeenCalledWith('/tmp/orca-export-test-id.html')
  })
})
