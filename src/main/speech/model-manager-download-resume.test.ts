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
function scriptRequest(factory: ScriptedResponseFactory): void {
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
}

const PAYLOAD = Buffer.from('0123456789abcdefghij')
// Keep stream-to-file flush delays real while retry timers advance.
const scheduleResponse = globalThis.setTimeout

async function advanceInterruptedRetry(
  attempt: Promise<void>,
  download: Promise<void>,
  filePath: string
): Promise<void> {
  await attempt.catch(() => undefined)
  await new Promise((resolve) => setImmediate(resolve))
  const partial = readFileSync(filePath)
  await vi.advanceTimersByTimeAsync(1_000)
  await download
  expect(partial).toEqual(PAYLOAD.subarray(0, 10))
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
      scriptRequest((sentHeaders) => {
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
      await advanceInterruptedRetry(firstAttempt.value, download, filePath)

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

      expect(readFileSync(filePath)).toEqual(PAYLOAD)
    } finally {
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

      expect(readFileSync(filePath)).toEqual(PAYLOAD)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects and discards a partial when Content-Range does not match the offset', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-model-resume-'))
    try {
      scriptRequest(() => ({
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
        retryable: true
      })
      expect(existsSync(filePath)).toBe(false)
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
      await advanceInterruptedRetry(firstAttempt.value, download, filePath)

      expect(readFileSync(filePath)).toEqual(PAYLOAD)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
