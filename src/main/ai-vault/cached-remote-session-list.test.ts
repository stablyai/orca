import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiVaultListResult } from '../../shared/ai-vault-types'
import type { IFilesystemProvider } from '../providers/types'
import { getRemoteHostPlatform } from '../ssh/ssh-remote-platform'

const { scanMock } = vi.hoisted(() => ({
  scanMock: vi.fn<() => Promise<AiVaultListResult>>()
}))

vi.mock('./remote-session-scanner', () => ({
  scanRemoteAiVaultSessions: scanMock
}))

import {
  listCachedRemoteAiVaultSessions,
  resetCachedRemoteAiVaultSessionsForTests
} from './cached-remote-session-list'

const EMPTY_RESULT: AiVaultListResult = {
  sessions: [],
  issues: [],
  scannedAt: '2026-07-29T00:00:00.000Z'
}

function args(provider: IFilesystemProvider, scopePaths: string[] = []) {
  return {
    provider,
    executionHostId: 'ssh:dev' as const,
    remoteHome: '/home/ada',
    hostPlatform: getRemoteHostPlatform('linux-x64'),
    scopePaths
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-07-29T00:00:00.000Z'))
  scanMock.mockReset().mockResolvedValue(EMPTY_RESULT)
  resetCachedRemoteAiVaultSessionsForTests()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('listCachedRemoteAiVaultSessions', () => {
  it('reuses completed results within 15 seconds and expires them afterward', async () => {
    const provider = {} as IFilesystemProvider
    await listCachedRemoteAiVaultSessions(args(provider))
    await listCachedRemoteAiVaultSessions(args(provider))
    expect(scanMock).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(15_001)
    await listCachedRemoteAiVaultSessions(args(provider))
    expect(scanMock).toHaveBeenCalledTimes(2)
  })

  it('shares identical in-flight scans even when the later caller forces', async () => {
    const provider = {} as IFilesystemProvider
    let resolve: (result: AiVaultListResult) => void = () => {}
    scanMock.mockReturnValueOnce(new Promise((done) => (resolve = done)))

    const first = listCachedRemoteAiVaultSessions(args(provider))
    const second = listCachedRemoteAiVaultSessions({ ...args(provider), force: true })
    expect(scanMock).toHaveBeenCalledTimes(1)
    resolve(EMPTY_RESULT)
    await expect(Promise.all([first, second])).resolves.toEqual([EMPTY_RESULT, EMPTY_RESULT])
  })

  it('isolates providers and bypasses only a completed entry on force', async () => {
    const firstProvider = {} as IFilesystemProvider
    const secondProvider = {} as IFilesystemProvider
    await listCachedRemoteAiVaultSessions(args(firstProvider))
    await listCachedRemoteAiVaultSessions(args(secondProvider))
    await listCachedRemoteAiVaultSessions({ ...args(firstProvider), force: true })
    expect(scanMock).toHaveBeenCalledTimes(3)
  })

  it('keys only the effective normalized, deduped and truncated scope paths', async () => {
    const provider = {} as IFilesystemProvider
    const base = Array.from({ length: 64 }, (_, index) => `/repo/${String(index).padStart(2, '0')}`)
    await listCachedRemoteAiVaultSessions(args(provider, [...base, base[0]]))
    await listCachedRemoteAiVaultSessions(args(provider, base.toReversed()))
    const overflow = await listCachedRemoteAiVaultSessions(
      args(provider, [...base, '/zzz-ignored-overflow'])
    )
    expect(scanMock).toHaveBeenCalledTimes(1)
    expect(overflow.issues).toContainEqual(
      expect.objectContaining({
        executionHostId: 'ssh:dev',
        message: 'Cursor sidecar scan truncated by the scope paths limit.'
      })
    )
  })

  it('isolates host identity, platform, home, and limit within one provider generation', async () => {
    const provider = {} as IFilesystemProvider
    const base = args(provider)
    await listCachedRemoteAiVaultSessions(base)
    await listCachedRemoteAiVaultSessions({ ...base, executionHostId: 'ssh:other' })
    await listCachedRemoteAiVaultSessions({ ...base, remoteHome: '/root' })
    await listCachedRemoteAiVaultSessions({
      ...base,
      hostPlatform: getRemoteHostPlatform('win32-x64')
    })
    await listCachedRemoteAiVaultSessions({ ...base, limit: 20 })
    expect(scanMock).toHaveBeenCalledTimes(5)
  })

  it('bounds completed cache keys per provider', async () => {
    const provider = {} as IFilesystemProvider
    for (let index = 0; index < 9; index += 1) {
      await listCachedRemoteAiVaultSessions({
        ...args(provider),
        limit: index + 1
      })
      vi.advanceTimersByTime(1)
    }
    await listCachedRemoteAiVaultSessions({ ...args(provider), limit: 1 })
    expect(scanMock).toHaveBeenCalledTimes(10)
  })

  it('evicts the least recently used completed key', async () => {
    const provider = {} as IFilesystemProvider
    for (let limit = 1; limit <= 8; limit++) {
      await listCachedRemoteAiVaultSessions({ ...args(provider), limit })
      vi.advanceTimersByTime(1)
    }
    await listCachedRemoteAiVaultSessions({ ...args(provider), limit: 1 })
    vi.advanceTimersByTime(1)
    await listCachedRemoteAiVaultSessions({ ...args(provider), limit: 9 })
    expect(scanMock).toHaveBeenCalledTimes(9)

    await listCachedRemoteAiVaultSessions({ ...args(provider), limit: 1 })
    expect(scanMock).toHaveBeenCalledTimes(9)
    await listCachedRemoteAiVaultSessions({ ...args(provider), limit: 2 })
    expect(scanMock).toHaveBeenCalledTimes(10)
  })

  it('does not cache a failed scan and retries the same key', async () => {
    const provider = {} as IFilesystemProvider
    scanMock.mockRejectedValueOnce(new Error('relay unavailable'))

    await expect(listCachedRemoteAiVaultSessions(args(provider))).rejects.toThrow(
      'relay unavailable'
    )
    await expect(listCachedRemoteAiVaultSessions(args(provider))).resolves.toBe(EMPTY_RESULT)
    expect(scanMock).toHaveBeenCalledTimes(2)
  })
})
