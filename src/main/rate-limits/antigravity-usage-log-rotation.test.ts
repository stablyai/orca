import type { Dirent } from 'node:fs'
import type * as FsPromises from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import type * as AntigravityLoopbackClient from './antigravity-loopback-client'

const { fetchQuotaEndpointMock, openMock, readdirMock } = vi.hoisted(() => ({
  fetchQuotaEndpointMock: vi.fn(),
  openMock: vi.fn(),
  readdirMock: vi.fn()
}))

vi.mock('electron', () => ({ app: { getPath: vi.fn() } }))

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof FsPromises>()),
  open: openMock,
  readdir: readdirMock
}))

vi.mock('./antigravity-loopback-client', async (importOriginal) => ({
  ...(await importOriginal<typeof AntigravityLoopbackClient>()),
  fetchAntigravityQuotaEndpoint: fetchQuotaEndpointMock
}))

import { fetchAntigravityRateLimits } from './antigravity-usage-fetcher'

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

describe('Antigravity rotating-log discovery', () => {
  it('continues to an older candidate when the newest selected log disappears', async () => {
    const limits: ProviderRateLimits = {
      provider: 'antigravity',
      session: { usedPercent: 25, windowMinutes: 300, resetsAt: null, resetDescription: null },
      weekly: null,
      updatedAt: 1,
      error: null,
      status: 'ok'
    }
    readdirMock.mockResolvedValue([
      logEntry('cli-20260815_120000.log'),
      logEntry('cli-20260815_110000.log')
    ])
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
})
