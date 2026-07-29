import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SPEECH_MODEL_CATALOG } from './model-catalog'
import { ModelManager } from './model-manager'

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
  verifyFileSha256: (filePath: string, expectedSha256: string) => Promise<void>
  downloadFileWithRetry: (
    url: string,
    filePath: string,
    expectedSize: number,
    modelId: string,
    isAborted: () => boolean,
    signal: AbortSignal,
    completedBytes?: number,
    modelTotalBytes?: number
  ) => Promise<void>
  downloadFile: (
    url: string,
    dest: string,
    expectedSize: number,
    modelId: string,
    isAborted: () => boolean,
    signal?: AbortSignal
  ) => Promise<void>
}

describe('ModelManager', () => {
  beforeEach(() => {
    netRequestMock.mockReset()
    hasOpenAiSpeechApiKeyMock.mockReset()
    hasOpenAiSpeechApiKeyMock.mockReturnValue(false)
  })

  it('requires pinned, internally consistent metadata for every model file', () => {
    for (const manifest of SPEECH_MODEL_CATALOG) {
      if (manifest.provider !== 'local') {
        continue
      }
      expect(manifest.downloadFiles?.length).toBeGreaterThan(0)
      expect(manifest.files).toEqual(manifest.downloadFiles?.map(({ name }) => name))
      expect(manifest.sizeBytes).toBe(
        manifest.downloadFiles?.reduce((total, { sizeBytes }) => total + sizeBytes, 0)
      )
      for (const file of manifest.downloadFiles ?? []) {
        expect(file.url).toMatch(
          /^https:\/\/huggingface\.co\/[^/]+\/[^/]+\/resolve\/[a-f0-9]{40}\//
        )
        expect(file.sha256).toMatch(/^[a-f0-9]{64}$/)
        expect(file.sizeBytes).toBeGreaterThan(0)
      }
    }
  })

  it('verifies downloaded model file hashes before installation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-model-manager-'))
    try {
      const filePath = join(dir, 'model.onnx')
      writeFileSync(filePath, 'known model bytes')
      const expected = createHash('sha256').update('known model bytes').digest('hex')
      const manager = new ModelManager(dir) as unknown as ModelManagerInternals

      await expect(manager.verifyFileSha256(filePath, expected)).resolves.toBeUndefined()
      await expect(manager.verifyFileSha256(filePath, '0'.repeat(64))).rejects.toThrow(
        /integrity verification/
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects non-HTTPS model downloads', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-model-manager-'))
    try {
      const manager = new ModelManager(dir) as unknown as ModelManagerInternals

      await expect(
        manager.downloadFile(
          'http://example.com/model.bin',
          join(dir, 'model.bin'),
          1,
          'm',
          () => false
        )
      ).rejects.toThrow(/HTTPS/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('installs individually verified model files through a staging directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-model-manager-'))
    try {
      const manifest = SPEECH_MODEL_CATALOG.find(
        (model) => model.id === 'zipformer-streaming-zh-14m'
      )!
      const manager = new ModelManager(dir)
      const internals = manager as unknown as ModelManagerInternals
      const downloadMock = vi
        .spyOn(internals, 'downloadFileWithRetry')
        .mockImplementation(async (_url, filePath, expectedSize) => {
          writeFileSync(filePath, '')
          truncateSync(filePath, expectedSize)
        })
      const verifyMock = vi.spyOn(internals, 'verifyFileSha256').mockResolvedValue()

      await manager.downloadModel(manifest.id)

      const modelDir = manager.getModelDir(manifest.id)
      expect(downloadMock).toHaveBeenCalledTimes(manifest.downloadFiles?.length ?? 0)
      expect(verifyMock).toHaveBeenCalledTimes(manifest.downloadFiles?.length ?? 0)
      let expectedOffset = 0
      for (const [index, file] of (manifest.downloadFiles ?? []).entries()) {
        expect(downloadMock.mock.calls[index]?.slice(6)).toEqual([
          expectedOffset,
          manifest.sizeBytes
        ])
        expectedOffset += file.sizeBytes
        expect(existsSync(join(modelDir, file.name))).toBe(true)
      }
      expect(existsSync(`${modelDir}.partial`)).toBe(false)
      await expect(manager.getModelState(manifest.id)).resolves.toEqual({
        id: manifest.id,
        status: 'ready'
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('marks OpenAI transcription models ready only when an API key is configured', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-model-manager-'))
    try {
      const manager = new ModelManager(dir)

      await expect(manager.getModelState('openai-gpt-4o-mini-transcribe')).resolves.toEqual({
        id: 'openai-gpt-4o-mini-transcribe',
        status: 'not-downloaded'
      })

      hasOpenAiSpeechApiKeyMock.mockReturnValue(true)

      await expect(manager.getModelState('openai-gpt-4o-mini-transcribe')).resolves.toEqual({
        id: 'openai-gpt-4o-mini-transcribe',
        status: 'ready'
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('deletes a ready local model and reports it as not downloaded', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-model-manager-'))
    try {
      const manifest = SPEECH_MODEL_CATALOG.find(
        (model) => model.id === 'zipformer-streaming-zh-14m'
      )
      expect(manifest?.files).toBeDefined()
      const manager = new ModelManager(dir)
      const modelDir = manager.getModelDir(manifest!.id)
      for (const file of manifest!.downloadFiles ?? []) {
        const path = join(modelDir, file.name)
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, '')
        truncateSync(path, file.sizeBytes)
      }

      await expect(manager.getModelState(manifest!.id)).resolves.toEqual({
        id: manifest!.id,
        status: 'ready'
      })
      await manager.deleteModel(manifest!.id)

      expect(existsSync(modelDir)).toBe(false)
      await expect(manager.getModelState(manifest!.id)).resolves.toEqual({
        id: manifest!.id,
        status: 'not-downloaded'
      })
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
      const manager = new ModelManager(dir)

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
      const manager = new ModelManager(dir) as unknown as ModelManagerInternals

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
      const manager = new ModelManager(dir) as unknown as ModelManagerInternals

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
