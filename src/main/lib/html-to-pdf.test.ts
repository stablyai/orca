import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'

const fake = vi.hoisted(() => ({
  files: new Map<string, string>(),
  handlers: new Map<string, (...args: unknown[]) => void>(),
  write: vi.fn<(path: string, html: string, encoding: string) => Promise<void>>(),
  unlink: vi.fn<(path: string) => Promise<void>>(),
  construct: vi.fn<(options: unknown) => void>(),
  load: vi.fn<(path: string) => Promise<void>>(),
  images: vi.fn<(script: string, userGesture: boolean) => Promise<void>>(),
  print: vi.fn<(options: unknown) => Promise<Buffer>>(),
  isDestroyed: vi.fn<() => boolean>(),
  destroy: vi.fn<() => void>(),
  uuid: vi.fn<() => string>()
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/mock-export-temp' },
  BrowserWindow: class {
    constructor(options: unknown) {
      fake.construct(options)
    }
    webContents = {
      once: (event: string, listener: (...args: unknown[]) => void) => {
        fake.handlers.set(event, listener)
      },
      executeJavaScript: fake.images,
      printToPDF: fake.print
    }
    loadFile = fake.load
    isDestroyed = fake.isDestroyed
    destroy = fake.destroy
  }
}))
vi.mock('node:fs/promises', () => ({ writeFile: fake.write, unlink: fake.unlink }))
vi.mock('node:crypto', () => ({ randomUUID: fake.uuid }))

import { ExportTimeoutError, htmlToPdf } from './html-to-pdf'

const HTML = '<p>synthetic export</p>'
const TEMP_PATH = join('/mock-export-temp', 'orca-export-test-export.html')
const PDF = Buffer.from('synthetic PDF buffer')

beforeEach(() => {
  vi.useFakeTimers()
  vi.resetAllMocks()
  fake.files.clear()
  fake.handlers.clear()
  fake.uuid.mockReturnValue('test-export')
  fake.write.mockImplementation(async (path, html) => {
    fake.files.set(path, html)
  })
  fake.unlink.mockImplementation(async (path) => {
    fake.files.delete(path)
  })
  fake.load.mockImplementation(async () => {
    fake.handlers.get('did-finish-load')?.()
  })
  fake.images.mockResolvedValue()
  fake.print.mockResolvedValue(PDF)
  fake.isDestroyed.mockReturnValue(false)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('htmlToPdf resource ownership', () => {
  it('removes the temporary document when window construction throws', async () => {
    const error = new Error('window construction failed')
    fake.construct.mockImplementation(() => {
      throw error
    })

    await expect(htmlToPdf(HTML)).rejects.toBe(error)

    expect(fake.write).toHaveBeenCalledWith(TEMP_PATH, HTML, 'utf-8')
    expect(fake.unlink).toHaveBeenCalledExactlyOnceWith(TEMP_PATH)
    expect(fake.files.size).toBe(0)
    expect(fake.destroy).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('removes a partial document when writing rejects', async () => {
    const error = new Error('disk full')
    fake.write.mockImplementation(async (path) => {
      fake.files.set(path, '<partial')
      throw error
    })

    await expect(htmlToPdf(HTML)).rejects.toBe(error)

    expect(fake.files.size).toBe(0)
    expect(fake.unlink).toHaveBeenCalledExactlyOnceWith(TEMP_PATH)
    expect(fake.construct).not.toHaveBeenCalled()
  })

  it('preserves the write error when no file exists and cleanup also rejects', async () => {
    const error = new Error('write denied')
    fake.write.mockRejectedValue(error)
    fake.unlink.mockRejectedValue(new Error('ENOENT'))

    await expect(htmlToPdf(HTML)).rejects.toBe(error)

    expect(fake.unlink).toHaveBeenCalledExactlyOnceWith(TEMP_PATH)
    expect(fake.construct).not.toHaveBeenCalled()
  })

  it('preserves the construction error when best-effort cleanup fails', async () => {
    const error = new Error('window construction failed')
    fake.construct.mockImplementation(() => {
      throw error
    })
    fake.unlink.mockRejectedValue(new Error('unlink denied'))

    await expect(htmlToPdf(HTML)).rejects.toBe(error)

    expect(fake.unlink).toHaveBeenCalledExactlyOnceWith(TEMP_PATH)
    expect(fake.files.size).toBe(1)
  })

  it('does not accumulate temporary documents across repeated failed exports', async () => {
    fake.construct.mockImplementation(() => {
      throw new Error('window construction failed')
    })
    for (let index = 0; index < 10; index++) {
      fake.uuid.mockReturnValue(`export-${index}`)
      await expect(htmlToPdf(HTML)).rejects.toThrow('window construction failed')
    }

    expect(fake.files.size).toBe(0)
    expect(fake.unlink).toHaveBeenCalledTimes(10)
  })

  it('keeps window security, print settings and the returned PDF unchanged', async () => {
    await expect(htmlToPdf(HTML)).resolves.toBe(PDF)

    expect(fake.construct).toHaveBeenCalledExactlyOnceWith({
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        javascript: true
      }
    })
    expect(fake.load).toHaveBeenCalledExactlyOnceWith(TEMP_PATH)
    expect(fake.images).toHaveBeenCalledWith(expect.stringContaining('document.images'), true)
    expect(fake.print).toHaveBeenCalledExactlyOnceWith({
      printBackground: true,
      pageSize: 'A4',
      margins: { top: 0.75, bottom: 0.75, left: 0.75, right: 0.75 }
    })
    expect(fake.destroy).toHaveBeenCalledOnce()
    expect(fake.unlink).toHaveBeenCalledExactlyOnceWith(TEMP_PATH)
    expect(fake.files.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('waits for images before printing', async () => {
    const images = Promise.withResolvers<void>()
    fake.images.mockReturnValue(images.promise)
    const result = htmlToPdf(HTML)
    await vi.advanceTimersByTimeAsync(0)

    expect(fake.images).toHaveBeenCalledOnce()
    expect(fake.print).not.toHaveBeenCalled()
    expect(fake.unlink).not.toHaveBeenCalled()

    images.resolve()
    await expect(result).resolves.toBe(PDF)
    expect(fake.print).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['images', 'print'] as const)('cleans up after %s failure', async (stage) => {
    const error = new Error(`${stage} failed`)
    fake[stage].mockRejectedValue(error)

    await expect(htmlToPdf(HTML)).rejects.toBe(error)

    expect(fake.destroy).toHaveBeenCalledOnce()
    expect(fake.files.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cleans up after a load rejection', async () => {
    const error = new Error('load failed')
    fake.load.mockRejectedValue(error)

    await expect(htmlToPdf(HTML)).rejects.toBe(error)

    expect(fake.destroy).toHaveBeenCalledOnce()
    expect(fake.files.size).toBe(0)
    expect(fake.images).not.toHaveBeenCalled()
  })

  it('keeps the render timeout type and clears its resources', async () => {
    const images = Promise.withResolvers<void>()
    fake.images.mockReturnValue(images.promise)
    const result = expect(htmlToPdf(HTML)).rejects.toBeInstanceOf(ExportTimeoutError)
    await vi.advanceTimersByTimeAsync(60_000)
    await result

    expect(fake.destroy).toHaveBeenCalledOnce()
    expect(fake.files.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    images.reject(new Error('late renderer failure'))
    await Promise.resolve()
  })

  it('does not destroy an already-destroyed window again', async () => {
    fake.isDestroyed.mockReturnValue(true)

    await expect(htmlToPdf(HTML)).resolves.toBe(PDF)

    expect(fake.destroy).not.toHaveBeenCalled()
    expect(fake.files.size).toBe(0)
  })

  it('still removes the document if window destruction throws', async () => {
    const error = new Error('window destruction failed')
    fake.destroy.mockImplementation(() => {
      throw error
    })

    await expect(htmlToPdf(HTML)).rejects.toBe(error)

    expect(fake.unlink).toHaveBeenCalledExactlyOnceWith(TEMP_PATH)
    expect(fake.files.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps a successful export successful when best-effort cleanup rejects', async () => {
    fake.unlink.mockRejectedValue(new Error('unlink denied'))

    await expect(htmlToPdf(HTML)).resolves.toBe(PDF)

    expect(fake.destroy).toHaveBeenCalledOnce()
    expect(fake.unlink).toHaveBeenCalledExactlyOnceWith(TEMP_PATH)
    expect(vi.getTimerCount()).toBe(0)
  })
})
