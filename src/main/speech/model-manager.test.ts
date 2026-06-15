import { createHash } from 'crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SPEECH_MODEL_CATALOG } from './model-catalog'
import { ModelManager } from './model-manager'

const { hasOpenAiSpeechApiKeyMock, netRequestMock, spawnMock } = vi.hoisted(() => ({
  hasOpenAiSpeechApiKeyMock: vi.fn(),
  netRequestMock: vi.fn(),
  spawnMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/orca-speech-models-test'
  },
  net: {
    request: netRequestMock
  }
}))

vi.mock('child_process', async () => {
  const actual = await vi.importActual('child_process')
  return { ...(actual as Record<string, unknown>), spawn: spawnMock }
})

vi.mock('./openai-api-key-store', () => ({
  hasOpenAiSpeechApiKey: hasOpenAiSpeechApiKeyMock
}))

type ModelManagerInternals = {
  verifyArchiveSha256: (archivePath: string, expectedSha256: string) => Promise<void>
  downloadFile: (
    url: string,
    dest: string,
    expectedSize: number,
    modelId: string,
    isAborted: () => boolean,
    signal?: AbortSignal
  ) => Promise<void>
  extractArchive: (
    archivePath: string,
    destDir: string,
    modelId: string,
    isAborted: () => boolean
  ) => Promise<void>
}

describe('ModelManager', () => {
  beforeEach(() => {
    netRequestMock.mockReset()
    hasOpenAiSpeechApiKeyMock.mockReset()
    hasOpenAiSpeechApiKeyMock.mockReturnValue(false)
    spawnMock.mockReset()
  })

  it('requires pinned SHA-256 hashes for every catalog archive', () => {
    for (const manifest of SPEECH_MODEL_CATALOG) {
      if (manifest.provider !== 'local') {
        continue
      }
      expect(manifest.archiveSha256).toMatch(/^[a-f0-9]{64}$/)
    }
  })

  it('verifies downloaded archive hashes before extraction', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-model-manager-'))
    try {
      const archivePath = join(dir, 'model.tar.bz2')
      writeFileSync(archivePath, 'known archive bytes')
      const expected = createHash('sha256').update('known archive bytes').digest('hex')
      const manager = new ModelManager(dir) as unknown as ModelManagerInternals

      await expect(manager.verifyArchiveSha256(archivePath, expected)).resolves.toBeUndefined()
      await expect(manager.verifyArchiveSha256(archivePath, '0'.repeat(64))).rejects.toThrow(
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
          'http://example.com/model.tar.bz2',
          join(dir, 'model.tar.bz2'),
          1,
          'm',
          () => false
        )
      ).rejects.toThrow(/HTTPS/)
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
        'https://example.com/model.tar.bz2',
        join(dir, 'model.tar.bz2'),
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
        'https://example.com/model.tar.bz2',
        join(dir, 'model.tar.bz2'),
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

  it('clears extraction abort polling when the child does not close', async () => {
    vi.useFakeTimers()
    const dir = mkdtempSync(join(tmpdir(), 'orca-model-manager-'))
    try {
      const handlers: Record<string, ((arg?: unknown) => void)[]> = {
        close: [],
        error: []
      }
      const stderrHandlers: ((chunk: Buffer) => void)[] = []
      const child = {
        stderr: {
          on: vi.fn((_event: string, cb: (chunk: Buffer) => void) => {
            stderrHandlers.push(cb)
            return child.stderr
          }),
          off: vi.fn((_event: string, cb: (chunk: Buffer) => void) => {
            const index = stderrHandlers.indexOf(cb)
            if (index !== -1) {
              stderrHandlers.splice(index, 1)
            }
            return child.stderr
          })
        },
        kill: vi.fn(),
        on: vi.fn((event: string, cb: (arg?: unknown) => void) => {
          handlers[event]?.push(cb)
          return child
        }),
        off: vi.fn((event: string, cb: (arg?: unknown) => void) => {
          handlers[event] = handlers[event]?.filter((handler) => handler !== cb) ?? []
          return child
        })
      }
      spawnMock.mockReturnValue(child)
      const manager = new ModelManager(dir) as unknown as ModelManagerInternals

      const extraction = manager.extractArchive(join(dir, 'model.tar.bz2'), dir, 'm', () => true)
      const rejection = expect(extraction).rejects.toThrow('Aborted')
      await vi.advanceTimersByTimeAsync(250)
      await rejection

      expect(child.kill).toHaveBeenCalledWith('SIGKILL')
      expect(child.kill).toHaveBeenCalledTimes(1)
      expect(handlers.close).toHaveLength(0)
      expect(handlers.error).toHaveLength(0)
      expect(stderrHandlers).toHaveLength(0)

      vi.advanceTimersByTime(1000)
      expect(child.kill).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
