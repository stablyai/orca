import { mkdtempSync, rmSync } from 'node:fs'
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

  it('removes response progress listeners after a model download finishes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-model-manager-'))
    try {
      const response = new PassThrough() as PassThrough & {
        statusCode: number
        headers: Record<string, string>
      }
      response.statusCode = 200
      response.headers = { 'content-length': '4' }
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
        'https://example.com/model.tar.bz2',
        join(dir, 'model.tar.bz2'),
        4,
        'm',
        () => false
      )
      response.write(Buffer.from('ab'))
      response.end(Buffer.from('cd'))

      await expect(download).resolves.toBeUndefined()
      expect(response.listenerCount('data')).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
