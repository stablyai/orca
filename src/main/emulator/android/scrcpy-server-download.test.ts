import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ root: '', get: vi.fn() }))
vi.mock('../../../shared/app-environment', () => ({
  getAppEnvironment: () => ({ getPath: () => state.root })
}))
vi.mock('node:https', () => ({ get: state.get }))

class DownloadResponse extends PassThrough {
  statusCode = 200
  headers: { location?: string } = {}
}

class DownloadRequest extends EventEmitter {
  setTimeout(): this {
    return this
  }
}

beforeEach(async () => {
  vi.resetModules()
  state.root = await mkdtemp(join(tmpdir(), 'orca-scrcpy-download-'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(state.root, { recursive: true, force: true })
})

async function prepareDownload() {
  const responses: DownloadResponse[] = []
  state.get.mockReset()
  state.get.mockImplementation((_url: string, callback: (response: DownloadResponse) => void) => {
    const response = new DownloadResponse()
    responses.push(response)
    queueMicrotask(() => callback?.(response))
    return new DownloadRequest()
  })
  return { get: state.get, responses, ...(await import('./scrcpy-server-download')) }
}

describe('scrcpy server download publication', () => {
  it('keeps concurrent callers waiting for the complete JAR', async () => {
    const download = await prepareDownload()
    const first = download.ensureScrcpyServerJar()
    const response = download.responses[0]!
    response.write(Buffer.alloc(16_384, 1))
    const directory = dirname(download.scrcpyServerJarPath())
    await vi.waitFor(async () => {
      const files = await readdir(directory)
      expect(files).toHaveLength(1)
      expect((await stat(join(directory, files[0]!))).size).toBe(16_384)
    })

    const completed: string[] = []
    const waiting = Array.from({ length: 2 }, () =>
      download.ensureScrcpyServerJar().then((path) => {
        completed.push(path)
        return path
      })
    )
    await new Promise<void>((resolve) => setImmediate(resolve))
    try {
      expect(download.isScrcpyServerJarReady()).toBe(false)
      expect(completed).toEqual([])
    } finally {
      response.end(Buffer.alloc(49_152, 2))
      await Promise.all([first, ...waiting])
    }

    const path = download.scrcpyServerJarPath()
    expect(completed).toEqual([path, path])
    expect(await readFile(path)).toEqual(
      Buffer.concat([Buffer.alloc(16_384, 1), Buffer.alloc(49_152, 2)])
    )
    expect(await readdir(directory)).toEqual([basename(path)])
    expect(download.get).toHaveBeenCalledTimes(1)
  })

  it('removes a failed partial download and permits a fresh attempt', async () => {
    const download = await prepareDownload()
    const failed = download.ensureScrcpyServerJar()
    const rejection = expect(failed).rejects.toThrow('interrupted')
    download.responses[0]!.write(Buffer.alloc(16_384))
    download.responses[0]!.destroy(new Error('interrupted'))
    await rejection
    expect(download.isScrcpyServerJarReady()).toBe(false)
    expect(await readdir(dirname(download.scrcpyServerJarPath()))).toEqual([])

    const retry = download.ensureScrcpyServerJar()
    download.responses[1]!.end(Buffer.alloc(32_768, 3))
    expect(await readFile(await retry)).toEqual(Buffer.alloc(32_768, 3))
  })
})
