import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ModelManager } from './model-manager'

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

describe('ModelManager stream cleanup', () => {
  beforeEach(() => {
    netRequestMock.mockReset()
  })

  it('reuses the idle timer and removes progress listeners after a fragmented download', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-model-manager-'))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    try {
      const response = new PassThrough() as PassThrough & {
        statusCode: number
        headers: Record<string, string>
      }
      response.statusCode = 200
      response.headers = { 'content-length': '1000' }
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
      const manager = new ModelManager(dir) as unknown as ModelManagerInternals

      const download = manager.downloadFile(
        'https://example.com/model.bin',
        join(dir, 'model.bin'),
        1000,
        'm',
        () => false
      )
      await vi.advanceTimersByTimeAsync(60_000)
      for (let index = 0; index < 1000; index += 1) {
        response.write(Buffer.from('a'))
      }
      await vi.advanceTimersByTimeAsync(119_999)
      expect(request.abort).not.toHaveBeenCalled()
      response.end()

      await expect(download).resolves.toBeUndefined()
      expect(response.listenerCount('data')).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
      expect(readFileSync(join(dir, 'model.bin'), 'utf8')).toBe('a'.repeat(1000))
      expect(timeoutSpy.mock.calls.filter(([, delay]) => delay === 120_000)).toHaveLength(1)
    } finally {
      timeoutSpy.mockRestore()
      vi.useRealTimers()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
