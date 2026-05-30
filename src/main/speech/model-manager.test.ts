import { createHash } from 'crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SPEECH_MODEL_CATALOG } from './model-catalog'
import { ModelManager } from './model-manager'

const { httpsGetMock, spawnMock } = vi.hoisted(() => ({
  httpsGetMock: vi.fn(),
  spawnMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/orca-speech-models-test'
  }
}))

vi.mock('child_process', async () => {
  const actual = await vi.importActual('child_process')
  return { ...(actual as Record<string, unknown>), spawn: spawnMock }
})

vi.mock('https', async () => {
  const actual = await vi.importActual('https')
  return { ...(actual as Record<string, unknown>), get: httpsGetMock }
})

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
    httpsGetMock.mockReset()
    spawnMock.mockReset()
  })

  it('requires pinned SHA-256 hashes for every catalog archive', () => {
    for (const manifest of SPEECH_MODEL_CATALOG) {
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

  it('aborts an in-flight model download request when cancelled', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-model-manager-'))
    try {
      const manifest = SPEECH_MODEL_CATALOG[0]
      const errorHandlers: ((err: Error) => void)[] = []
      const request = {
        destroy: vi.fn((err?: Error) => {
          queueMicrotask(() => {
            for (const handler of errorHandlers) {
              handler(err ?? new Error('destroyed'))
            }
          })
          return request
        }),
        on: vi.fn((event: string, cb: (err: Error) => void) => {
          if (event === 'error') {
            errorHandlers.push(cb)
          }
          return request
        })
      }
      httpsGetMock.mockImplementation(
        (
          _url: URL,
          options: { signal?: AbortSignal } | ((response: unknown) => void),
          _cb?: (response: unknown) => void
        ) => {
          if (typeof options !== 'function') {
            options.signal?.addEventListener('abort', () => request.destroy(new Error('Aborted')), {
              once: true
            })
          }
          return request
        }
      )
      const manager = new ModelManager(dir)

      const download = manager.downloadModel(manifest.id)
      manager.cancelDownload(manifest.id)
      await expect(download).resolves.toBeUndefined()

      expect(request.destroy).toHaveBeenCalledWith(expect.any(Error))
      expect((await manager.getModelState(manifest.id)).status).toBe('not-downloaded')
    } finally {
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
