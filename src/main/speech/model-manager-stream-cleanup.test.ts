import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ModelManager } from './model-manager'
import { openElectronSpeechDownloadRequest } from '../host/electron-speech-services'

const { netRequestMock } = vi.hoisted(() => ({
  netRequestMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/orca-speech-models-test'
  },
  net: {
    request: netRequestMock
  }
}))

type ModelManagerInternals = {
  downloadFile: (
    url: string,
    dest: string,
    expectedSize: number,
    modelId: string,
    isAborted: () => boolean,
    signal?: AbortSignal
  ) => Promise<void>
}

function managerInternals(dir: string): ModelManagerInternals {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the tests drive the download hooks the class keeps protected.
  return new ModelManager(
    dir,
    openElectronSpeechDownloadRequest
  ) as unknown as ModelManagerInternals
}

describe('ModelManager stream cleanup', () => {
  beforeEach(() => {
    netRequestMock.mockReset()
  })

  it('aborts the native request when the destination cannot be opened', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-model-manager-'))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const response = Object.assign(new PassThrough(), {
        statusCode: 200,
        headers: { 'content-length': '1000' }
      })
      const request = Object.assign(new EventEmitter(), {
        abort: vi.fn(),
        end: vi.fn(() => request.emit('response', response))
      })
      netRequestMock.mockReturnValue(request)
      const controller = new AbortController()
      const removeAbort = vi.spyOn(controller.signal, 'removeEventListener')
      const download = managerInternals(dir).downloadFile(
        'https://example.com/model.bin',
        dir,
        1000,
        'm',
        () => false,
        controller.signal
      )

      await expect(download).rejects.toMatchObject({
        code: expect.any(String),
        path: dir,
        syscall: 'open'
      })
      expect(request.abort).toHaveBeenCalledTimes(1)
      expect(response.destroyed).toBe(true)
      expect(response.listenerCount('data')).toBe(0)
      expect(request.eventNames()).toEqual([])
      expect(removeAbort).toHaveBeenCalledWith('abort', expect.any(Function))
      expect(vi.getTimerCount()).toBe(0)
      controller.abort()
      expect(request.abort).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('extends the idle deadline and releases listeners after a fragmented download', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-model-manager-'))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const payload = 'abcdefgh'
    try {
      const response = new PassThrough() as PassThrough & {
        statusCode: number
        headers: Record<string, string>
      }
      response.statusCode = 200
      response.headers = { 'content-length': String(payload.length) }
      const responseHandlers: ((response: unknown) => void)[] = []
      const request = {
        abort: vi.fn(() => request),
        end: vi.fn(() => {
          for (const handler of responseHandlers) {
            handler(response)
          }
          return request
        }),
        on: vi.fn((event: string, cb: (response: unknown) => void) => {
          if (event === 'response') {
            responseHandlers.push(cb)
          }
          return request
        }),
        off: vi.fn(() => request)
      }
      netRequestMock.mockReturnValue(request)
      const manager = managerInternals(dir)

      const download = manager.downloadFile(
        'https://example.com/model.bin',
        join(dir, 'model.bin'),
        payload.length,
        'm',
        () => false
      )
      await vi.advanceTimersByTimeAsync(60_000)
      for (const byte of payload) {
        response.write(Buffer.from(byte))
      }
      await vi.advanceTimersByTimeAsync(119_999)
      expect(request.abort).not.toHaveBeenCalled()
      response.end()

      await expect(download).resolves.toBeUndefined()
      expect(response.listenerCount('data')).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
      expect(readFileSync(join(dir, 'model.bin'), 'utf8')).toBe(payload)
    } finally {
      vi.useRealTimers()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
