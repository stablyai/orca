import { join } from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  releaseSshRelayArtifactCacheLockPath,
  SSH_RELAY_ARTIFACT_CACHE_LOCK_RELEASE_LIMITS,
  type SshRelayArtifactCacheLockReleaseOperations
} from './ssh-relay-artifact-cache-lock-release'

function fileError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`filesystem ${code}`), { code })
}

const lockPath = join('cache', 'locks', `${'a'.repeat(64)}.lock`)
const token = 'b'.repeat(32)
let now = 0
const operations = {
  rename: vi.fn<SshRelayArtifactCacheLockReleaseOperations['rename']>(),
  remove: vi.fn<SshRelayArtifactCacheLockReleaseOperations['remove']>(),
  wait: vi.fn<SshRelayArtifactCacheLockReleaseOperations['wait']>(),
  now: vi.fn<SshRelayArtifactCacheLockReleaseOperations['now']>()
}

beforeEach(() => {
  now = 0
  operations.rename.mockReset()
  operations.remove.mockReset().mockResolvedValue(undefined)
  operations.wait.mockReset().mockImplementation(async () => {
    now += SSH_RELAY_ARTIFACT_CACHE_LOCK_RELEASE_LIMITS.retryIntervalMs
  })
  operations.now.mockReset().mockImplementation(() => now)
})

describe('SSH relay artifact cache lock release', () => {
  it('pins a bounded retry policy below cancellation settlement', () => {
    expect(SSH_RELAY_ARTIFACT_CACHE_LOCK_RELEASE_LIMITS).toEqual({
      retryIntervalMs: 50,
      retryTimeoutMs: 5_000
    })
    expect(Object.isFrozen(SSH_RELAY_ARTIFACT_CACHE_LOCK_RELEASE_LIMITS)).toBe(true)
  })

  it('rechecks ownership before retrying transient Windows sharing failures', async () => {
    const checkOwnership = vi.fn(async () => 'owned' as const)
    operations.rename
      .mockRejectedValueOnce(fileError('EPERM'))
      .mockRejectedValueOnce(fileError('EACCES'))
      .mockResolvedValueOnce(undefined)

    await expect(
      releaseSshRelayArtifactCacheLockPath({ lockPath, token, checkOwnership }, operations)
    ).resolves.toBeUndefined()

    const tombstone = `${lockPath}.released-${token}`
    expect(operations.rename).toHaveBeenCalledTimes(3)
    expect(operations.rename).toHaveBeenNthCalledWith(1, lockPath, tombstone)
    expect(checkOwnership).toHaveBeenCalledTimes(2)
    expect(operations.wait).toHaveBeenCalledTimes(2)
    expect(operations.remove).toHaveBeenCalledWith(tombstone)
  })

  it('stops without deleting when ownership is displaced during a sharing retry', async () => {
    const checkOwnership = vi.fn(async () => 'displaced' as const)
    operations.rename.mockRejectedValueOnce(fileError('EPERM'))

    await expect(
      releaseSshRelayArtifactCacheLockPath({ lockPath, token, checkOwnership }, operations)
    ).resolves.toBeUndefined()

    expect(operations.rename).toHaveBeenCalledTimes(1)
    expect(operations.wait).toHaveBeenCalledTimes(1)
    expect(operations.remove).not.toHaveBeenCalled()
  })

  it('fails closed after the exact retry budget without deleting the owned lock', async () => {
    const checkOwnership = vi.fn(async () => 'owned' as const)
    operations.rename.mockRejectedValue(fileError('EPERM'))

    await expect(
      releaseSshRelayArtifactCacheLockPath({ lockPath, token, checkOwnership }, operations)
    ).rejects.toThrow(/release|sharing|timeout|blocked/i)

    expect(now).toBe(SSH_RELAY_ARTIFACT_CACHE_LOCK_RELEASE_LIMITS.retryTimeoutMs)
    expect(operations.wait).toHaveBeenCalledTimes(
      SSH_RELAY_ARTIFACT_CACHE_LOCK_RELEASE_LIMITS.retryTimeoutMs /
        SSH_RELAY_ARTIFACT_CACHE_LOCK_RELEASE_LIMITS.retryIntervalMs
    )
    expect(operations.remove).not.toHaveBeenCalled()
  })

  it('treats an already absent owned path as released', async () => {
    const checkOwnership = vi.fn(async () => 'owned' as const)
    operations.rename.mockRejectedValueOnce(fileError('ENOENT'))

    await expect(
      releaseSshRelayArtifactCacheLockPath({ lockPath, token, checkOwnership }, operations)
    ).resolves.toBeUndefined()
    expect(checkOwnership).not.toHaveBeenCalled()
    expect(operations.wait).not.toHaveBeenCalled()
    expect(operations.remove).not.toHaveBeenCalled()
  })

  it('propagates unexpected filesystem failures without retry or deletion', async () => {
    const checkOwnership = vi.fn(async () => 'owned' as const)
    operations.rename.mockRejectedValueOnce(fileError('EIO'))

    await expect(
      releaseSshRelayArtifactCacheLockPath({ lockPath, token, checkOwnership }, operations)
    ).rejects.toThrow(/filesystem EIO/i)
    expect(checkOwnership).not.toHaveBeenCalled()
    expect(operations.wait).not.toHaveBeenCalled()
    expect(operations.remove).not.toHaveBeenCalled()
  })

  it('propagates ownership-inspection errors instead of guessing displacement', async () => {
    const checkOwnership = vi.fn(async () => {
      throw fileError('EIO')
    })
    operations.rename.mockRejectedValueOnce(fileError('EPERM'))

    await expect(
      releaseSshRelayArtifactCacheLockPath({ lockPath, token, checkOwnership }, operations)
    ).rejects.toThrow(/filesystem EIO/i)
    expect(operations.rename).toHaveBeenCalledTimes(1)
    expect(operations.wait).toHaveBeenCalledTimes(1)
    expect(operations.remove).not.toHaveBeenCalled()
  })
})
