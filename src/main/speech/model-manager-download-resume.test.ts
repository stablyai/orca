import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
  downloadFileWithRetry: (
    url: string,
    filePath: string,
    expectedSize: number,
    modelId: string,
    isAborted: () => boolean,
    signal: AbortSignal
  ) => Promise<void>
  downloadFile: (
    url: string,
    filePath: string,
    expectedSize: number,
    modelId: string,
    isAborted: () => boolean,
    signal?: AbortSignal,
    redirectCount?: number,
    resumeOffset?: number
  ) => Promise<void>
  getPartialDownloadBytes: (filePath: string) => number
}

function managerInternals(dir: string): ModelManagerInternals {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the tests drive the download hooks the class keeps protected.
  return new ModelManager(
    dir,
    openElectronSpeechDownloadRequest
  ) as unknown as ModelManagerInternals
}

type ScriptedResponse = {
  statusCode: number
  headers?: Record<string, string>
  chunks?: Buffer[]
  failWith?: string
}

type ScriptedResponseFactory = (sentHeaders: Record<string, string>) => ScriptedResponse

// Use real Readable bodies so mid-body destruction exercises production stream.pipeline behavior.
function scriptRequest(factory: ScriptedResponseFactory): {
  sentHeaders: Record<string, string>
  abortMock: ReturnType<typeof vi.fn>
} {
  const sentHeaders: Record<string, string> = {}
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const addListener = (event: string, cb: (...args: unknown[]) => void): void => {
    const set = listeners.get(event) ?? new Set()
    set.add(cb)
    listeners.set(event, set)
  }
  const abortMock = vi.fn(() => request)
  const request = {
    setHeader: vi.fn((name: string, value: string) => {
      sentHeaders[name.toLowerCase()] = value
    }),
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      addListener(event, cb)
      return request
    }),
    off: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      listeners.get(event)?.delete(cb)
      return request
    }),
    abort: abortMock,
    end: vi.fn(() => {
      queueMicrotask(() => {
        const spec = factory(sentHeaders)
        const response = Object.assign(new Readable({ read() {} }), {
          statusCode: spec.statusCode,
          headers: spec.headers ?? {}
        })
        for (const cb of listeners.get('response') ?? []) {
          cb(response)
        }
        scheduleResponse(() => {
          for (const chunk of spec.chunks ?? []) {
            response.push(chunk)
          }
          // Fail on a later tick so pushed chunks reach the file first.
          scheduleResponse(() => {
            if (spec.failWith) {
              response.destroy(new Error(spec.failWith))
            } else {
              response.push(null)
            }
          }, 20)
        }, 20)
      })
      return request
    })
  }
  netRequestMock.mockImplementationOnce(() => request)
  return { sentHeaders, abortMock }
}

const PAYLOAD = Buffer.from('0123456789abcdefghij')
// Keep stream-to-file flush delays real while retry timers advance.
const scheduleResponse = globalThis.setTimeout

async function advanceInterruptedRetry(
  attempt: Promise<void>,
  download: Promise<void>,
  filePath: string,
  message: string
): Promise<void> {
  await expect(attempt).rejects.toThrow(message)
  await new Promise((resolve) => setImmediate(resolve))
  const partial = readFileSync(filePath)
  const requestsBeforeRetry = netRequestMock.mock.calls.length
  await vi.advanceTimersByTimeAsync(999)
  const requestsBeforeDeadline = netRequestMock.mock.calls.length
  await vi.advanceTimersByTimeAsync(1)
  await download
  expect(partial).toEqual(PAYLOAD.subarray(0, 10))
  expect(requestsBeforeRetry).toBe(1)
  expect(requestsBeforeDeadline).toBe(1)
}

describe('ModelManager download resume', () => {
  beforeEach(() => {
    netRequestMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('resumes an interrupted download with a Range request and assembles the full file', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const dir = mkdtempSync(join(tmpdir(), 'orca-model-resume-'))
    try {
      scriptRequest(() => ({
        statusCode: 200,
        headers: { 'content-length': String(PAYLOAD.length) },
        chunks: [PAYLOAD.subarray(0, 10)],
        failWith: 'net::ERR_CONTENT_LENGTH_MISMATCH'
      }))
      const second = scriptRequest((sentHeaders) => {
        expect(sentHeaders.range).toBe('bytes=10-')
        return {
          statusCode: 206,
          headers: {
            'content-length': String(PAYLOAD.length - 10),
            'content-range': `bytes 10-${PAYLOAD.length - 1}/${PAYLOAD.length}`
          },
          chunks: [PAYLOAD.subarray(10)]
        }
      })
      const manager = managerInternals(dir)
      const filePath = join(dir, 'model.bin')
      const attempt = vi.spyOn(manager, 'downloadFile')

      const download = manager.downloadFileWithRetry(
        'https://example.com/model.bin',
        filePath,
        PAYLOAD.length,
        'm',
        () => false,
        new AbortController().signal
      )

      const firstAttempt = attempt.mock.results[0]
      if (firstAttempt?.type !== 'return') {
        throw new Error('First download attempt did not start')
      }
      await advanceInterruptedRetry(
        firstAttempt.value,
        download,
        filePath,
        'net::ERR_CONTENT_LENGTH_MISMATCH'
      )

      expect(netRequestMock).toHaveBeenCalledTimes(2)
      expect(second.sentHeaders.range).toBe('bytes=10-')
      expect(readFileSync(filePath)).toEqual(PAYLOAD)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('uses a complete file after a late transport failure without requesting past EOF', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-model-resume-'))
    try {
      scriptRequest(() => ({
        statusCode: 200,
        headers: { 'content-length': String(PAYLOAD.length) },
        chunks: [PAYLOAD],
        failWith: 'net::ERR_CONNECTION_RESET'
      }))
      const manager = managerInternals(dir)
      const filePath = join(dir, 'model.bin')

      await manager.downloadFileWithRetry(
        'https://example.com/model.bin',
        filePath,
        PAYLOAD.length,
        'm',
        () => false,
        new AbortController().signal
      )

      expect(netRequestMock).toHaveBeenCalledTimes(1)
      expect(readFileSync(filePath)).toEqual(PAYLOAD)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('requests the remaining bytes when a clean range response ends before the file total', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-model-resume-'))
    try {
      const first = scriptRequest((sentHeaders) => {
        expect(sentHeaders.range).toBe('bytes=10-')
        return {
          statusCode: 206,
          headers: {
            'content-length': '5',
            'content-range': `bytes 10-14/${PAYLOAD.length}`
          },
          chunks: [PAYLOAD.subarray(10, 15)]
        }
      })
      const second = scriptRequest((sentHeaders) => {
        expect(sentHeaders.range).toBe('bytes=15-')
        return {
          statusCode: 206,
          headers: {
            'content-length': '5',
            'content-range': `bytes 15-19/${PAYLOAD.length}`
          },
          chunks: [PAYLOAD.subarray(15)]
        }
      })
      const manager = managerInternals(dir)
      const filePath = join(dir, 'model.bin')
      writeFileSync(filePath, PAYLOAD.subarray(0, 10))

      await manager.downloadFileWithRetry(
        'https://example.com/model.bin',
        filePath,
        PAYLOAD.length,
        'm',
        () => false,
        new AbortController().signal
      )

      expect(netRequestMock).toHaveBeenCalledTimes(2)
      expect(first.sentHeaders.range).toBe('bytes=10-')
      expect(second.sentHeaders.range).toBe('bytes=15-')
      expect(readFileSync(filePath)).toEqual(PAYLOAD)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('continues through more than eight advancing range segments', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-model-resume-'))
    try {
      for (let offset = 1; offset <= 9; offset += 1) {
        scriptRequest((sentHeaders) => {
          expect(sentHeaders.range).toBe(`bytes=${offset}-`)
          return {
            statusCode: 206,
            headers: {
              'content-length': '1',
              'content-range': `bytes ${offset}-${offset}/${PAYLOAD.length}`
            },
            chunks: [PAYLOAD.subarray(offset, offset + 1)]
          }
        })
      }
      scriptRequest((sentHeaders) => {
        expect(sentHeaders.range).toBe('bytes=10-')
        return {
          statusCode: 206,
          headers: {
            'content-length': '10',
            'content-range': `bytes 10-19/${PAYLOAD.length}`
          },
          chunks: [PAYLOAD.subarray(10)]
        }
      })
      const manager = managerInternals(dir)
      const filePath = join(dir, 'model.bin')
      writeFileSync(filePath, PAYLOAD.subarray(0, 1))

      await manager.downloadFileWithRetry(
        'https://example.com/model.bin',
        filePath,
        PAYLOAD.length,
        'm',
        () => false,
        new AbortController().signal
      )

      expect(netRequestMock).toHaveBeenCalledTimes(10)
      expect(readFileSync(filePath)).toEqual(PAYLOAD)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('bounds a server that advances by pathologically tiny segments forever', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-model-resume-'))
    try {
      const manager = managerInternals(dir)
      const filePath = join(dir, 'model.bin')
      let bytesWritten = 0
      // Read progress from memory: 4096 real file operations stall under parallel load.
      vi.spyOn(manager, 'getPartialDownloadBytes').mockImplementation(() => bytesWritten)
      // Advance one byte forever without completing before the absolute request ceiling.
      const downloadFileMock = vi.spyOn(manager, 'downloadFile').mockImplementation(() => {
        bytesWritten += 1
        return Promise.resolve()
      })

      await expect(
        manager.downloadFileWithRetry(
          'https://example.com/model.bin',
          filePath,
          1_000_000,
          'm',
          () => false,
          new AbortController().signal
        )
      ).rejects.toThrow(/too many download requests/)

      expect(downloadFileMock).toHaveBeenCalledTimes(4_096)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps resuming a download that advances across many mid-stream drops', async () => {
    vi.useFakeTimers()
    const dir = mkdtempSync(join(tmpdir(), 'orca-model-resume-'))
    try {
      // Progress must reset the stall budget; the former fixed budget abandoned advancing downloads near attempt 8.
      const manager = managerInternals(dir)
      const filePath = join(dir, 'model.bin')
      const SLICE = 2
      let delivered = 0
      const downloadFileMock = vi.spyOn(manager, 'downloadFile').mockImplementation(() => {
        delivered = Math.min(delivered + SLICE, PAYLOAD.length)
        writeFileSync(filePath, PAYLOAD.subarray(0, delivered))
        return Promise.reject(new Error('net::ERR_CONNECTION_RESET'))
      })

      const download = manager.downloadFileWithRetry(
        'https://example.com/model.bin',
        filePath,
        PAYLOAD.length,
        'm',
        () => false,
        new AbortController().signal
      )
      const outcome = download.then(
        () => 'resolved',
        (error: unknown) => (error instanceof Error ? error.message : String(error))
      )
      // Each advancing failure resets backoff to 1s; allow more than the ten required attempts.
      await vi.advanceTimersByTimeAsync(30_000)

      await expect(outcome).resolves.toBe('resolved')
      expect(downloadFileMock).toHaveBeenCalledTimes(PAYLOAD.length / SLICE)
      expect(readFileSync(filePath)).toEqual(PAYLOAD)
    } finally {
      vi.useRealTimers()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps the known file total when Content-Range omits it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-model-resume-'))
    try {
      scriptRequest((sentHeaders) => {
        expect(sentHeaders.range).toBe('bytes=10-')
        return {
          statusCode: 206,
          headers: {
            'content-length': '5',
            'content-range': 'bytes 10-14/*'
          },
          chunks: [PAYLOAD.subarray(10, 15)]
        }
      })
      scriptRequest((sentHeaders) => {
        expect(sentHeaders.range).toBe('bytes=15-')
        return {
          statusCode: 206,
          headers: {
            'content-length': '5',
            'content-range': 'bytes 15-19/*'
          },
          chunks: [PAYLOAD.subarray(15)]
        }
      })
      const manager = managerInternals(dir)
      const filePath = join(dir, 'model.bin')
      writeFileSync(filePath, PAYLOAD.subarray(0, 10))

      await manager.downloadFileWithRetry(
        'https://example.com/model.bin',
        filePath,
        PAYLOAD.length,
        'm',
        () => false,
        new AbortController().signal
      )

      expect(netRequestMock).toHaveBeenCalledTimes(2)
      expect(readFileSync(filePath)).toEqual(PAYLOAD)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects and discards a partial when Content-Range does not match the offset', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-model-resume-'))
    try {
      const mismatched = scriptRequest(() => ({
        statusCode: 206,
        headers: {
          'content-length': '10',
          'content-range': `bytes 0-9/${PAYLOAD.length}`
        },
        chunks: [PAYLOAD.subarray(0, 10)]
      }))
      const manager = managerInternals(dir)
      const filePath = join(dir, 'model.bin')
      writeFileSync(filePath, PAYLOAD.subarray(0, 10))

      const error = await manager
        .downloadFile(
          'https://example.com/model.bin',
          filePath,
          PAYLOAD.length,
          'm',
          () => false,
          new AbortController().signal,
          0,
          10
        )
        .catch((cause: unknown) => cause)

      expect(error).toMatchObject({
        message: 'Invalid Content-Range for resume at byte 10',
        retryable: true
      })
      expect(existsSync(filePath)).toBe(false)
      expect(mismatched.abortMock).toHaveBeenCalledTimes(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('restarts from scratch when the server ignores the Range request', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const dir = mkdtempSync(join(tmpdir(), 'orca-model-resume-'))
    try {
      scriptRequest(() => ({
        statusCode: 200,
        headers: { 'content-length': String(PAYLOAD.length) },
        chunks: [PAYLOAD.subarray(0, 10)],
        failWith: 'net::ERR_CONNECTION_RESET'
      }))
      scriptRequest(() => ({
        statusCode: 200,
        headers: { 'content-length': String(PAYLOAD.length) },
        chunks: [PAYLOAD]
      }))
      const manager = managerInternals(dir)
      const filePath = join(dir, 'model.bin')
      const attempt = vi.spyOn(manager, 'downloadFile')

      const download = manager.downloadFileWithRetry(
        'https://example.com/model.bin',
        filePath,
        PAYLOAD.length,
        'm',
        () => false,
        new AbortController().signal
      )

      const firstAttempt = attempt.mock.results[0]
      if (firstAttempt?.type !== 'return') {
        throw new Error('First download attempt did not start')
      }
      await advanceInterruptedRetry(
        firstAttempt.value,
        download,
        filePath,
        'net::ERR_CONNECTION_RESET'
      )

      expect(netRequestMock).toHaveBeenCalledTimes(2)
      expect(readFileSync(filePath)).toEqual(PAYLOAD)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not retry non-transient failures', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-model-resume-'))
    try {
      scriptRequest(() => ({ statusCode: 404 }))
      const manager = managerInternals(dir)

      await expect(
        manager.downloadFileWithRetry(
          'https://example.com/model.bin',
          join(dir, 'model.bin'),
          PAYLOAD.length,
          'm',
          () => false,
          new AbortController().signal
        )
      ).rejects.toThrow('HTTP 404')

      expect(netRequestMock).toHaveBeenCalledTimes(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('aborts an HTTP error response instead of draining it after rejection', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-model-resume-'))
    try {
      const scripted = scriptRequest(() => ({
        statusCode: 429,
        headers: { 'retry-after': '3' }
      }))
      const manager = managerInternals(dir)

      const error = await manager
        .downloadFile(
          'https://example.com/model.bin',
          join(dir, 'model.bin'),
          PAYLOAD.length,
          'm',
          () => false
        )
        .catch((cause: unknown) => cause)

      expect(error).toMatchObject({ message: 'HTTP 429', httpStatusCode: 429, retryAfterMs: 3_000 })
      expect(scripted.abortMock).toHaveBeenCalledTimes(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('honors Retry-After before issuing another request', async () => {
    vi.useFakeTimers()
    const dir = mkdtempSync(join(tmpdir(), 'orca-model-resume-'))
    try {
      const manager = managerInternals(dir)
      const filePath = join(dir, 'model.bin')
      const rateLimitError = Object.assign(new Error('HTTP 429'), {
        httpStatusCode: 429,
        retryAfterMs: 3_000
      })
      const downloadFileMock = vi
        .spyOn(manager, 'downloadFile')
        .mockRejectedValueOnce(rateLimitError)
        .mockImplementationOnce(() => {
          writeFileSync(filePath, PAYLOAD)
          return Promise.resolve()
        })
      const download = manager.downloadFileWithRetry(
        'https://example.com/model.bin',
        filePath,
        PAYLOAD.length,
        'm',
        () => false,
        new AbortController().signal
      )

      await vi.advanceTimersByTimeAsync(2_999)
      expect(downloadFileMock).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)

      await expect(download).resolves.toBeUndefined()
      expect(downloadFileMock).toHaveBeenCalledTimes(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not retry before an excessively long Retry-After window', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-model-resume-'))
    try {
      const manager = managerInternals(dir)
      const rateLimitError = Object.assign(new Error('HTTP 429'), {
        httpStatusCode: 429,
        retryAfterMs: 300_000
      })
      const downloadFileMock = vi.spyOn(manager, 'downloadFile').mockRejectedValue(rateLimitError)

      await expect(
        manager.downloadFileWithRetry(
          'https://example.com/model.bin',
          join(dir, 'model.bin'),
          PAYLOAD.length,
          'm',
          () => false,
          new AbortController().signal
        )
      ).rejects.toThrow('server requested retry after 300 seconds')

      expect(downloadFileMock).toHaveBeenCalledTimes(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('gives up after repeated zero-progress failures with a diagnosable error', async () => {
    vi.useFakeTimers()
    const dir = mkdtempSync(join(tmpdir(), 'orca-model-resume-'))
    try {
      const manager = managerInternals(dir)
      const downloadFileMock = vi
        .spyOn(manager, 'downloadFile')
        .mockRejectedValue(new Error('net::ERR_CONNECTION_RESET'))

      const download = manager.downloadFileWithRetry(
        'https://example.com/model.bin',
        join(dir, 'model.bin'),
        PAYLOAD.length,
        'm',
        () => false,
        new AbortController().signal
      )
      const outcome = download.then(
        () => 'resolved',
        (error: unknown) => (error instanceof Error ? error.message : String(error))
      )
      // Let backoff schedule before advancing fake time to avoid racing real stream/file I/O.
      await vi.advanceTimersByTimeAsync(0)
      expect(downloadFileMock).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(999)
      expect(downloadFileMock).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(downloadFileMock).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(1_999)
      expect(downloadFileMock).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(1)
      expect(downloadFileMock).toHaveBeenCalledTimes(3)
      await vi.advanceTimersByTimeAsync(3_999)
      expect(downloadFileMock).toHaveBeenCalledTimes(3)
      await vi.advanceTimersByTimeAsync(1)

      await expect(outcome).resolves.toMatch(
        /Model download interrupted at 0% \(0 of 20 bytes\) after 4 attempts: .*net::ERR_CONNECTION_RESET/
      )
      expect(downloadFileMock).toHaveBeenCalledTimes(4)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('stops retrying once the download is aborted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-model-resume-'))
    try {
      scriptRequest(() => ({
        statusCode: 200,
        headers: { 'content-length': String(PAYLOAD.length) },
        failWith: 'net::ERR_CONNECTION_RESET'
      }))
      const controller = new AbortController()
      const manager = managerInternals(dir)

      const download = manager.downloadFileWithRetry(
        'https://example.com/model.bin',
        join(dir, 'model.bin'),
        PAYLOAD.length,
        'm',
        () => false,
        controller.signal
      )
      const outcome = download.then(
        () => 'resolved',
        (error: unknown) => (error instanceof Error ? error.message : String(error))
      )
      // Abort during backoff must settle without another request.
      setTimeout(() => controller.abort(), 100)
      const message = await outcome

      expect(message).toBe('Aborted')
      expect(netRequestMock).toHaveBeenCalledTimes(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
