import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ExecutionHostNotDispatchableError } from '../../../providers/execution-host-provider-dispatch'
import { RuntimeTerminalFileGrants, type RuntimeTerminalFileGrantHost } from './file-grants'

const artifactPath = join(tmpdir(), 'orca-grant-ownership.txt')
const ttl = 10 * 60 * 1000

function createGrants(
  worktreeId = 'folder-1',
  executionHostId: 'local' | 'ssh:other' | 'runtime:other' = 'local'
) {
  const resolveRuntimeFileTarget = vi.fn(async () => ({
    worktree: { id: worktreeId },
    executionHostId
  }))
  return {
    grants: new RuntimeTerminalFileGrants({ resolveRuntimeFileTarget }),
    resolveRuntimeFileTarget
  }
}

function mint(grants: RuntimeTerminalFileGrants, clientId?: string) {
  return grants.createTerminalFileGrant({
    worktreeId: 'folder-1',
    absolutePath: artifactPath,
    clientId,
    provenance: 'terminal-output',
    stats: { dev: 1, ino: 2, nlink: 1, size: 12, mtimeMs: 3 }
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
})

afterEach(() => {
  vi.clearAllTimers()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('RuntimeTerminalFileGrants', () => {
  it('refreshes one expiry timer and survives the original deadline', async () => {
    const { grants } = createGrants()
    const grant = mint(grants, 'client-a')
    await vi.advanceTimersByTimeAsync(ttl / 2)
    grants.refreshTerminalFileGrant(grant)
    expect(vi.getTimerCount()).toBe(1)

    await vi.advanceTimersByTimeAsync(ttl / 2 + 1)
    await expect(
      grants.requireTerminalFileGrant('folder-1', grant.id, artifactPath, 'client-a')
    ).resolves.toMatchObject({ grant })

    await vi.advanceTimersByTimeAsync(ttl / 2)
    expect(vi.getTimerCount()).toBe(0)
    await expect(
      grants.requireTerminalFileGrant('folder-1', grant.id, artifactPath, 'client-a')
    ).rejects.toThrow('terminal_file_grant_expired')
  })

  it('revokes only the disconnected client and clears only its timer', async () => {
    const { grants } = createGrants()
    const a = mint(grants, 'client-a')
    const b = mint(grants, 'client-b')
    const unbound = mint(grants)

    grants.revokeTerminalFileGrantsForClient('client-a')
    expect(vi.getTimerCount()).toBe(2)
    await expect(
      grants.requireTerminalFileGrant('folder-1', a.id, artifactPath, 'client-a')
    ).rejects.toThrow('terminal_file_grant_expired')
    await expect(
      grants.requireTerminalFileGrant('folder-1', b.id, artifactPath, 'client-b')
    ).resolves.toMatchObject({ grant: b })
    await expect(
      grants.requireTerminalFileGrant('folder-1', unbound.id, artifactPath)
    ).resolves.toMatchObject({ grant: unbound })
  })

  it('does not share grants between owners with the same client and workspace', async () => {
    const first = createGrants().grants
    const second = createGrants().grants
    const grant = mint(first, 'client-a')
    await expect(
      second.requireTerminalFileGrant('folder-1', grant.id, artifactPath, 'client-a')
    ).rejects.toThrow('terminal_file_grant_expired')
    second.revokeTerminalFileGrantsForClient('client-a')
    await expect(
      first.requireTerminalFileGrant('folder-1', grant.id, artifactPath, 'client-a')
    ).resolves.toMatchObject({ grant })
  })

  it.each(['worktree', 'path', 'host', 'client'] as const)(
    'rejects a grant whose %s identity differs',
    async (mismatch) => {
      const { grants } = createGrants(
        mismatch === 'worktree' ? 'folder-2' : 'folder-1',
        mismatch === 'host' ? 'ssh:other' : 'local'
      )
      const grant = mint(grants, 'client-a')
      await expect(
        grants.requireTerminalFileGrant(
          'folder-1',
          grant.id,
          mismatch === 'path' ? join(tmpdir(), 'other.txt') : artifactPath,
          mismatch === 'client' ? 'client-b' : 'client-a'
        )
      ).rejects.toThrow('terminal_file_grant_mismatch')
    }
  )

  it('refuses to use a local grant for a workspace on another runtime', async () => {
    const { grants } = createGrants('folder-1', 'runtime:other')
    const grant = mint(grants, 'client-a')
    await expect(
      grants.requireTerminalFileGrant('folder-1', grant.id, artifactPath, 'client-a')
    ).rejects.toBeInstanceOf(ExecutionHostNotDispatchableError)
  })

  it('resolves the execution target before pruning an expired grant', async () => {
    const resolveRuntimeFileTarget = vi.fn<
      RuntimeTerminalFileGrantHost['resolveRuntimeFileTarget']
    >(async () => {
      throw new Error('runtime_unavailable')
    })
    const grants = new RuntimeTerminalFileGrants({ resolveRuntimeFileTarget })
    const grant = mint(grants, 'client-a')
    vi.setSystemTime(grant.expiresAt + 1)

    await expect(
      grants.requireTerminalFileGrant('folder-1', grant.id, artifactPath, 'client-a')
    ).rejects.toThrow('runtime_unavailable')
    expect(vi.getTimerCount()).toBe(1)
  })

  it('never reinserts a revoked grant when in-flight access refreshes it', async () => {
    const { grants } = createGrants()
    const grant = mint(grants, 'client-a')
    grants.revokeTerminalFileGrantsForClient('client-a')
    grants.refreshTerminalFileGrant(grant)
    await expect(
      grants.requireTerminalFileGrant('folder-1', grant.id, artifactPath, 'client-a')
    ).rejects.toThrow('terminal_file_grant_expired')
  })

  it('ignores an already-queued expiry callback after a refresh', async () => {
    const timer = vi.spyOn(globalThis, 'setTimeout')
    const { grants } = createGrants()
    const grant = mint(grants, 'client-a')
    const callback = timer.mock.calls[0]?.[0]
    if (typeof callback !== 'function') {
      throw new Error('Expected grant expiry callback')
    }
    const originalDeadline = grant.expiresAt

    vi.setSystemTime(ttl / 2)
    grants.refreshTerminalFileGrant(grant)
    vi.setSystemTime(originalDeadline)
    callback()
    await expect(
      grants.requireTerminalFileGrant('folder-1', grant.id, artifactPath, 'client-a')
    ).resolves.toMatchObject({ grant })
  })
})
