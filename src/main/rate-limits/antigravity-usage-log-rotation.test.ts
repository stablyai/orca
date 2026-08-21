import type { Dirent } from 'node:fs'
import type * as FsPromises from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import type * as AntigravityLoopbackClient from './antigravity-loopback-client'

const { fetchQuotaEndpointMock, openMock, opendirMock } = vi.hoisted(() => ({
  fetchQuotaEndpointMock: vi.fn(),
  openMock: vi.fn(),
  opendirMock: vi.fn()
}))

vi.mock('electron', () => ({ app: { getPath: vi.fn() } }))

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof FsPromises>()),
  open: openMock,
  opendir: opendirMock
}))

vi.mock('./antigravity-loopback-client', async (importOriginal) => ({
  ...(await importOriginal<typeof AntigravityLoopbackClient>()),
  fetchAntigravityQuotaEndpoint: fetchQuotaEndpointMock
}))

import { fetchAntigravityRateLimits } from './antigravity-usage-fetcher'
import { AntigravityLoopbackResponseError } from './antigravity-loopback-client'

function logEntry(name: string): Dirent {
  return { name, isFile: () => true } as Dirent
}

function readableLog(contents: string): unknown {
  const bytes = Buffer.from(contents)
  return {
    stat: vi.fn(async () => ({ isFile: () => true, size: bytes.length })),
    read: vi.fn(async (buffer: Buffer) => {
      bytes.copy(buffer)
      return { buffer, bytesRead: bytes.length }
    }),
    close: vi.fn(async () => undefined)
  }
}

function readableDirectory(entries: Dirent[]): unknown {
  let index = 0
  return {
    read: vi.fn(async () => entries[index++] ?? null),
    close: vi.fn(async () => undefined)
  }
}

function generatedLogDirectory(entryCount: number): unknown {
  let index = 0
  return {
    read: vi.fn(async () => {
      if (index >= entryCount) {
        return null
      }
      const name = `cli-20260815_${String(index).padStart(6, '0')}.log`
      index += 1
      return logEntry(name)
    }),
    close: vi.fn(async () => undefined)
  }
}

describe('Antigravity rotating-log discovery', () => {
  afterEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  it('continues to an older candidate when the newest selected log disappears', async () => {
    const limits: ProviderRateLimits = {
      provider: 'antigravity',
      session: { usedPercent: 25, windowMinutes: 300, resetsAt: null, resetDescription: null },
      weekly: null,
      updatedAt: 1,
      error: null,
      status: 'ok'
    }
    opendirMock.mockResolvedValue(
      readableDirectory([logEntry('cli-20260815_120000.log'), logEntry('cli-20260815_110000.log')])
    )
    openMock
      .mockRejectedValueOnce(Object.assign(new Error('rotated away'), { code: 'ENOENT' }))
      .mockResolvedValueOnce(
        readableLog('Language server listening on random port at 40200 for HTTP')
      )
    fetchQuotaEndpointMock.mockResolvedValue(limits)

    await expect(
      fetchAntigravityRateLimits({ homePath: '/home/test', appDataPath: '/app-data' })
    ).resolves.toBe(limits)
    expect(openMock).toHaveBeenCalledTimes(2)
    expect(fetchQuotaEndpointMock).toHaveBeenCalledWith('http:', 40_200, expect.any(AbortSignal))
  })

  it('falls back after a newer runtime starts but does not complete its response', async () => {
    const limits: ProviderRateLimits = {
      provider: 'antigravity',
      session: { usedPercent: 25, windowMinutes: 300, resetsAt: null, resetDescription: null },
      weekly: null,
      updatedAt: 1,
      error: null,
      status: 'ok'
    }
    opendirMock.mockResolvedValue(
      readableDirectory([logEntry('cli-20260815_120000.log'), logEntry('cli-20260815_110000.log')])
    )
    openMock
      .mockResolvedValueOnce(
        readableLog('Language server listening on random port at 40201 for HTTP')
      )
      .mockResolvedValueOnce(
        readableLog('Language server listening on random port at 40200 for HTTP')
      )
    fetchQuotaEndpointMock
      .mockRejectedValueOnce(
        new AntigravityLoopbackResponseError('Antigravity quota response timed out', false)
      )
      .mockResolvedValueOnce(limits)

    await expect(
      fetchAntigravityRateLimits({ homePath: '/home/test', appDataPath: '/app-data' })
    ).resolves.toBe(limits)
    expect(fetchQuotaEndpointMock).toHaveBeenNthCalledWith(
      1,
      'http:',
      40_201,
      expect.any(AbortSignal)
    )
    expect(fetchQuotaEndpointMock).toHaveBeenNthCalledWith(
      2,
      'http:',
      40_200,
      expect.any(AbortSignal)
    )
  })

  it('retains only the twelve newest candidates from a large directory stream', async () => {
    opendirMock.mockResolvedValue(generatedLogDirectory(10_000))
    openMock.mockImplementation(async (filePath: string) => {
      if (filePath.endsWith('language_server.log')) {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      }
      return readableLog('no listener in this log')
    })

    await fetchAntigravityRateLimits({ homePath: '/home/test', appDataPath: '/app-data' })

    const cliPaths = openMock.mock.calls
      .map(([filePath]) => filePath as string)
      .filter((filePath) => filePath.includes('cli-'))
    expect(cliPaths).toHaveLength(12)
    expect(cliPaths[0]).toMatch(/cli-20260815_009999\.log$/)
    expect(cliPaths.at(-1)).toMatch(/cli-20260815_009988\.log$/)
  })

  it('applies the total discovery deadline to a stalled directory open', async () => {
    vi.useFakeTimers()
    const close = vi.fn(async () => undefined)
    const directory = { read: vi.fn(async () => null), close }
    let finishOpen: ((value: unknown) => void) | undefined
    opendirMock.mockReturnValue(
      new Promise((resolve) => {
        finishOpen = resolve
      })
    )

    const result = fetchAntigravityRateLimits({
      homePath: '/home/test',
      appDataPath: '/app-data'
    })
    await vi.advanceTimersByTimeAsync(6_000)

    await expect(result).resolves.toMatchObject({
      status: 'error',
      error: 'Antigravity usage lookup timed out',
      usageMetadata: { failureKind: 'usage-unavailable' }
    })

    finishOpen?.(directory)
    await Promise.resolve()
    await Promise.resolve()
    expect(close).toHaveBeenCalledOnce()
  })
})
