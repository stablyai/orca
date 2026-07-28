import { beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsync, readLocalGitConfigSignature, state } = vi.hoisted(() => {
  const state = { signature: undefined as string | undefined }
  return {
    state,
    gitExecFileAsync: vi.fn(),
    readLocalGitConfigSignature: vi.fn(async () => state.signature)
  }
})
vi.mock('./runner', () => ({ gitExecFileAsync }))
vi.mock('../github/local-git-config-signature', () => ({ readLocalGitConfigSignature }))

import {
  __resetGitRemoteMetadataCacheForTests,
  getRemoteListRaw,
  getRemoteVerboseRaw,
  invalidateGitRemoteMetadata
} from './git-remote-metadata'

beforeEach(() => {
  __resetGitRemoteMetadataCacheForTests()
  gitExecFileAsync.mockReset()
  readLocalGitConfigSignature.mockClear()
  state.signature = 'sig-1'
})

describe('git-remote-metadata', () => {
  it('serves a stable-signature repeat read from cache without re-spawning', async () => {
    gitExecFileAsync.mockResolvedValue({ stdout: 'origin\nupstream\n', stderr: '' })

    const first = await getRemoteListRaw('/repo')
    const second = await getRemoteListRaw('/repo')

    expect(first).toBe('origin\nupstream\n')
    expect(second).toBe(first)
    expect(gitExecFileAsync).toHaveBeenCalledTimes(1)
    expect(gitExecFileAsync).toHaveBeenCalledWith(['remote'], { cwd: '/repo' })
  })

  it('re-reads once the .git/config signature changes', async () => {
    gitExecFileAsync.mockResolvedValue({ stdout: 'origin\n', stderr: '' })

    await getRemoteListRaw('/repo')
    state.signature = 'sig-2'
    await getRemoteListRaw('/repo')

    expect(gitExecFileAsync).toHaveBeenCalledTimes(2)
  })

  it('coalesces concurrent reads of the same op into one spawn', async () => {
    gitExecFileAsync.mockResolvedValue({ stdout: 'origin\n', stderr: '' })

    const [a, b] = await Promise.all([getRemoteListRaw('/repo'), getRemoteListRaw('/repo')])

    expect(a).toBe('origin\n')
    expect(b).toBe('origin\n')
    expect(gitExecFileAsync).toHaveBeenCalledTimes(1)
  })

  it('does not cache errors', async () => {
    gitExecFileAsync
      .mockRejectedValueOnce(new Error('git lock'))
      .mockResolvedValue({ stdout: 'origin\n', stderr: '' })

    await expect(getRemoteListRaw('/repo')).rejects.toThrow('git lock')
    const recovered = await getRemoteListRaw('/repo')

    expect(recovered).toBe('origin\n')
    expect(gitExecFileAsync).toHaveBeenCalledTimes(2)
  })

  it('caches the names and verbose reads independently', async () => {
    gitExecFileAsync.mockImplementation(async (args: string[]) => ({
      stdout: args.includes('-v') ? 'origin\thttps://x (fetch)\n' : 'origin\n',
      stderr: ''
    }))

    await getRemoteListRaw('/repo')
    await getRemoteVerboseRaw('/repo')
    await getRemoteListRaw('/repo')
    await getRemoteVerboseRaw('/repo')

    expect(gitExecFileAsync).toHaveBeenCalledTimes(2)
    expect(gitExecFileAsync).toHaveBeenCalledWith(['remote'], { cwd: '/repo' })
    expect(gitExecFileAsync).toHaveBeenCalledWith(['remote', '-v'], { cwd: '/repo' })
  })

  it('re-reads after an explicit invalidation', async () => {
    gitExecFileAsync.mockResolvedValue({ stdout: 'origin\n', stderr: '' })

    await getRemoteListRaw('/repo')
    invalidateGitRemoteMetadata('/repo')
    await getRemoteListRaw('/repo')

    expect(gitExecFileAsync).toHaveBeenCalledTimes(2)
  })

  it('does not let an invalidated in-flight probe repopulate the cache', async () => {
    let resolveStale!: (result: { stdout: string; stderr: string }) => void
    const staleProbe = new Promise<{ stdout: string; stderr: string }>((resolve) => {
      resolveStale = resolve
    })
    gitExecFileAsync
      .mockReturnValueOnce(staleProbe)
      .mockResolvedValueOnce({ stdout: 'fresh\n', stderr: '' })

    const pendingStale = getRemoteListRaw('/repo')
    await vi.waitFor(() => expect(gitExecFileAsync).toHaveBeenCalledTimes(1))
    invalidateGitRemoteMetadata('/repo')

    await expect(getRemoteListRaw('/repo')).resolves.toBe('fresh\n')
    resolveStale({ stdout: 'stale\n', stderr: '' })
    await expect(pendingStale).resolves.toBe('stale\n')
    await expect(getRemoteListRaw('/repo')).resolves.toBe('fresh\n')
    expect(gitExecFileAsync).toHaveBeenCalledTimes(2)
  })

  it('caches on the TTL path when no signature is available (WSL/relay)', async () => {
    state.signature = undefined
    gitExecFileAsync.mockResolvedValue({ stdout: 'origin\n', stderr: '' })

    await getRemoteListRaw('/repo')
    await getRemoteListRaw('/repo')

    expect(gitExecFileAsync).toHaveBeenCalledTimes(1)
  })
})
