import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  truncateSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SPEECH_MODEL_CATALOG } from './model-catalog'
import { ModelManager } from './model-manager'
import { openElectronSpeechDownloadRequest } from '../host/electron-speech-services'

const { hasOpenAiSpeechApiKeyMock, netRequestMock } = vi.hoisted(() => ({
  hasOpenAiSpeechApiKeyMock: vi.fn(),
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

vi.mock('./openai-api-key-store', () => ({
  hasOpenAiSpeechApiKey: hasOpenAiSpeechApiKeyMock
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

describe('ModelManager', () => {
  beforeEach(() => {
    netRequestMock.mockReset()
    hasOpenAiSpeechApiKeyMock.mockReset()
    hasOpenAiSpeechApiKeyMock.mockReturnValue(false)
  })

  it('reports a model downloaded in the old sherpa-onnx format as needing an update', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-model-manager-'))
    try {
      const manager = new ModelManager(dir, openElectronSpeechDownloadRequest)
      const modelDir = manager.getModelDir('parakeet-tdt-0.6b-v2-int8')
      mkdirSync(modelDir, { recursive: true })
      for (const [name, size] of [
        ['encoder.int8.onnx', 652_184_296],
        ['decoder.int8.onnx', 7_257_753],
        ['joiner.int8.onnx', 1_739_080],
        ['tokens.txt', 9_384]
      ] as const) {
        writeFileSync(join(modelDir, name), '')
        truncateSync(join(modelDir, name), size)
      }

      await expect(manager.getModelState('parakeet-tdt-0.6b-v2-int8')).resolves.toEqual({
        id: 'parakeet-tdt-0.6b-v2-int8',
        status: 'not-downloaded',
        needsUpdate: true
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps the old files after a cancelled or failed update, so the update is offered again', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-model-manager-'))
    try {
      const modelId = 'parakeet-tdt-0.6b-v2-int8'
      const manager = new ModelManager(dir, openElectronSpeechDownloadRequest)
      const modelDir = manager.getModelDir(modelId)
      mkdirSync(modelDir, { recursive: true })
      for (const [name, size] of [
        ['encoder.int8.onnx', 652_184_296],
        ['decoder.int8.onnx', 7_257_753],
        ['joiner.int8.onnx', 1_739_080],
        ['tokens.txt', 9_384]
      ] as const) {
        writeFileSync(join(modelDir, name), '')
        truncateSync(join(modelDir, name), size)
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the test stubs the protected file download step.
      const internals = manager as unknown as {
        downloadModelFiles: (
          manifest: unknown,
          stagingDir: string,
          modelId: string,
          isAborted: () => boolean,
          signal: AbortSignal
        ) => Promise<void>
      }

      internals.downloadModelFiles = (_manifest, _stagingDir, _modelId, _isAborted, signal) =>
        new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')))
        })
      const cancelled = manager.downloadModel(modelId)
      manager.cancelDownload(modelId)
      await expect(cancelled).resolves.toBeUndefined()
      expect((await manager.getModelState(modelId)).needsUpdate).toBe(true)

      const failed = new ModelManager(dir, openElectronSpeechDownloadRequest)
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: as above.
      ;(failed as unknown as typeof internals).downloadModelFiles = async () => {
        throw new Error('network down')
      }
      await expect(failed.downloadModel(modelId)).rejects.toThrow('network down')
      expect(existsSync(`${modelDir}.partial`)).toBe(false)
      const state = await new ModelManager(dir, openElectronSpeechDownloadRequest).getModelState(
        modelId
      )
      expect(state.needsUpdate).toBe(true)

      const failedSwap = new ModelManager(dir, openElectronSpeechDownloadRequest)
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: as above.
      ;(failedSwap as unknown as typeof internals).downloadModelFiles = async (_m, stagingDir) => {
        rmSync(stagingDir, { recursive: true, force: true })
      }
      await expect(failedSwap.downloadModel(modelId)).rejects.toThrow('ENOENT')
      expect(existsSync(`${modelDir}.previous`)).toBe(false)
      expect((await failedSwap.getModelState(modelId)).needsUpdate).toBe(true)

      // An interrupted swap leaves the old files only in .previous.
      renameSync(modelDir, `${modelDir}.previous`)
      await expect(failedSwap.downloadModel(modelId)).rejects.toThrow('ENOENT')
      expect((await failedSwap.getModelState(modelId)).needsUpdate).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('aborts an in-flight model download request when cancelled', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-model-manager-'))
    try {
      const manifest = SPEECH_MODEL_CATALOG[0]
      const errorHandlers: ((err: Error) => void)[] = []
      const responseHandlers: ((response: unknown) => void)[] = []
      const redirectHandlers: ((
        statusCode: number,
        method: string,
        redirectUrl: string
      ) => void)[] = []
      const request = {
        abort: vi.fn(() => {
          queueMicrotask(() => {
            for (const handler of errorHandlers) {
              handler(new Error('Aborted'))
            }
          })
          return request
        }),
        on: vi.fn((event: string, cb: (err: Error) => void) => {
          if (event === 'error') {
            errorHandlers.push(cb)
          } else if (event === 'response') {
            responseHandlers.push(cb as unknown as (response: unknown) => void)
          } else if (event === 'redirect') {
            redirectHandlers.push(
              cb as unknown as (statusCode: number, method: string, redirectUrl: string) => void
            )
          }
          return request
        }),
        off: vi.fn((event: string, cb: ((err: Error) => void) | (() => void)) => {
          if (event === 'error') {
            const index = errorHandlers.indexOf(cb as (err: Error) => void)
            if (index !== -1) {
              errorHandlers.splice(index, 1)
            }
          }
          if (event === 'response') {
            const index = responseHandlers.indexOf(cb as (response: unknown) => void)
            if (index !== -1) {
              responseHandlers.splice(index, 1)
            }
          }
          if (event === 'redirect') {
            const index = redirectHandlers.indexOf(
              cb as (statusCode: number, method: string, redirectUrl: string) => void
            )
            if (index !== -1) {
              redirectHandlers.splice(index, 1)
            }
          }
          return request
        }),
        end: vi.fn(() => request)
      }
      netRequestMock.mockReturnValue(request)
      const manager = new ModelManager(dir, openElectronSpeechDownloadRequest)

      const download = manager.downloadModel(manifest.id)
      manager.cancelDownload(manifest.id)
      await expect(download).resolves.toBeUndefined()

      expect(netRequestMock).toHaveBeenCalledWith({
        method: 'GET',
        url: expect.stringMatching(/^https:\/\//)
      })
      expect(request.end).toHaveBeenCalled()
      expect(request.abort).toHaveBeenCalled()
      expect(request.off).toHaveBeenCalledWith('error', expect.any(Function))
      expect(request.off).toHaveBeenCalledWith('response', expect.any(Function))
      expect(request.off).toHaveBeenCalledWith('redirect', expect.any(Function))
      expect(errorHandlers).toHaveLength(0)
      expect(responseHandlers).toHaveLength(0)
      expect(redirectHandlers).toHaveLength(0)
      expect((await manager.getModelState(manifest.id)).status).toBe('not-downloaded')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('settles immediately when the abort signal fires before a response', async () => {
    vi.useFakeTimers()
    const dir = mkdtempSync(join(tmpdir(), 'orca-model-manager-'))
    try {
      const errorHandlers: ((err: Error) => void)[] = []
      const responseHandlers: ((response: unknown) => void)[] = []
      const redirectHandlers: ((
        statusCode: number,
        method: string,
        redirectUrl: string
      ) => void)[] = []
      const request = {
        abort: vi.fn(() => request),
        on: vi.fn((event: string, cb: (err: Error) => void) => {
          if (event === 'error') {
            errorHandlers.push(cb)
          } else if (event === 'response') {
            responseHandlers.push(cb as unknown as (response: unknown) => void)
          } else if (event === 'redirect') {
            redirectHandlers.push(
              cb as unknown as (statusCode: number, method: string, redirectUrl: string) => void
            )
          }
          return request
        }),
        off: vi.fn((event: string, cb: ((err: Error) => void) | (() => void)) => {
          if (event === 'error') {
            const index = errorHandlers.indexOf(cb as (err: Error) => void)
            if (index !== -1) {
              errorHandlers.splice(index, 1)
            }
          }
          if (event === 'response') {
            const index = responseHandlers.indexOf(cb as (response: unknown) => void)
            if (index !== -1) {
              responseHandlers.splice(index, 1)
            }
          }
          if (event === 'redirect') {
            const index = redirectHandlers.indexOf(
              cb as (statusCode: number, method: string, redirectUrl: string) => void
            )
            if (index !== -1) {
              redirectHandlers.splice(index, 1)
            }
          }
          return request
        }),
        end: vi.fn(() => request)
      }
      netRequestMock.mockReturnValue(request)
      const controller = new AbortController()
      const manager = managerInternals(dir)

      const download = manager.downloadFile(
        'https://example.com/model.bin',
        join(dir, 'model.bin'),
        1,
        'm',
        () => true,
        controller.signal
      )
      const outcomePromise = download.then(
        () => 'resolved',
        (error) => (error instanceof Error ? error.message : String(error))
      )
      controller.abort()
      await vi.advanceTimersByTimeAsync(0)

      await expect(outcomePromise).resolves.toBe('Aborted')
      expect(request.abort).toHaveBeenCalled()
      expect(request.off).toHaveBeenCalledWith('error', expect.any(Function))
      expect(request.off).toHaveBeenCalledWith('response', expect.any(Function))
      expect(request.off).toHaveBeenCalledWith('redirect', expect.any(Function))
      expect(errorHandlers).toHaveLength(0)
      expect(responseHandlers).toHaveLength(0)
      expect(redirectHandlers).toHaveLength(0)
    } finally {
      vi.useRealTimers()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('times out a model download request that never responds', async () => {
    vi.useFakeTimers()
    const dir = mkdtempSync(join(tmpdir(), 'orca-model-manager-'))
    try {
      const errorHandlers: ((err: Error) => void)[] = []
      const responseHandlers: ((response: unknown) => void)[] = []
      const redirectHandlers: ((
        statusCode: number,
        method: string,
        redirectUrl: string
      ) => void)[] = []
      const request = {
        abort: vi.fn(() => request),
        on: vi.fn((event: string, cb: (err: Error) => void) => {
          if (event === 'error') {
            errorHandlers.push(cb)
          } else if (event === 'response') {
            responseHandlers.push(cb as unknown as (response: unknown) => void)
          } else if (event === 'redirect') {
            redirectHandlers.push(
              cb as unknown as (statusCode: number, method: string, redirectUrl: string) => void
            )
          }
          return request
        }),
        off: vi.fn((event: string, cb: ((err: Error) => void) | (() => void)) => {
          if (event === 'error') {
            const index = errorHandlers.indexOf(cb as (err: Error) => void)
            if (index !== -1) {
              errorHandlers.splice(index, 1)
            }
          }
          if (event === 'response') {
            const index = responseHandlers.indexOf(cb as (response: unknown) => void)
            if (index !== -1) {
              responseHandlers.splice(index, 1)
            }
          }
          if (event === 'redirect') {
            const index = redirectHandlers.indexOf(
              cb as (statusCode: number, method: string, redirectUrl: string) => void
            )
            if (index !== -1) {
              redirectHandlers.splice(index, 1)
            }
          }
          return request
        }),
        end: vi.fn(() => request)
      }
      netRequestMock.mockReturnValue(request)
      const manager = managerInternals(dir)

      const download = manager.downloadFile(
        'https://example.com/model.bin',
        join(dir, 'model.bin'),
        1,
        'm',
        () => false
      )
      const outcomePromise = download.then(
        () => 'resolved',
        (error) => (error instanceof Error ? error.message : String(error))
      )

      await vi.advanceTimersByTimeAsync(120_000)
      const outcome = await Promise.race([outcomePromise, Promise.resolve('pending')])

      expect(outcome).toBe('Model download timed out after 120 seconds without network activity')
      expect(request.abort).toHaveBeenCalledWith()
      expect(request.off).toHaveBeenCalledWith('error', expect.any(Function))
      expect(request.off).toHaveBeenCalledWith('response', expect.any(Function))
      expect(request.off).toHaveBeenCalledWith('redirect', expect.any(Function))
      expect(errorHandlers).toHaveLength(0)
      expect(responseHandlers).toHaveLength(0)
      expect(redirectHandlers).toHaveLength(0)
    } finally {
      vi.useRealTimers()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
