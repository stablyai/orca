import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { PassThrough } from 'stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ModelManager } from './model-manager'

const { httpsGetMock } = vi.hoisted(() => ({
  httpsGetMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/orca-speech-models-test'
  }
}))

vi.mock('https', async () => {
  const actual = await vi.importActual('https')
  return { ...(actual as Record<string, unknown>), get: httpsGetMock }
})

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
    httpsGetMock.mockReset()
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
      const request = {
        destroy: vi.fn(() => request),
        setTimeout: vi.fn(() => request),
        on: vi.fn(() => request),
        off: vi.fn(() => request)
      }
      httpsGetMock.mockImplementation((_url: URL, cb: (response: unknown) => void) => {
        cb(response)
        return request
      })
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
