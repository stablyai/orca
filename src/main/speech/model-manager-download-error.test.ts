import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SPEECH_MODEL_CATALOG } from './model-catalog'
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

describe('ModelManager download failures', () => {
  beforeEach(() => {
    netRequestMock.mockReset()
  })

  it('rejects failed model downloads so the caller can surface the error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-model-manager-'))
    try {
      const manifest = SPEECH_MODEL_CATALOG[0]
      const errorHandlers: ((err: Error) => void)[] = []
      const request = {
        abort: vi.fn(() => request),
        end: vi.fn(() => {
          queueMicrotask(() => {
            for (const handler of errorHandlers) {
              handler(new Error('network down'))
            }
          })
          return request
        }),
        on: vi.fn((event: string, cb: (err: Error) => void) => {
          if (event === 'error') {
            errorHandlers.push(cb)
          }
          return request
        }),
        off: vi.fn((event: string, cb: (err: Error) => void) => {
          if (event === 'error') {
            const index = errorHandlers.indexOf(cb)
            if (index !== -1) {
              errorHandlers.splice(index, 1)
            }
          }
          return request
        })
      }
      netRequestMock.mockReturnValue(request)
      const manager = new ModelManager(dir)

      await expect(manager.downloadModel(manifest.id)).rejects.toThrow('network down')

      expect(request.off).toHaveBeenCalledWith('error', expect.any(Function))
      expect(errorHandlers).toHaveLength(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
