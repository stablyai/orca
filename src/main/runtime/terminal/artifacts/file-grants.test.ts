import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { RuntimeTerminalFileGrants } from './file-grants'

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

it('never reinserts a revoked grant when in-flight access refreshes it', async () => {
  vi.useFakeTimers()
  const artifactPath = join(tmpdir(), 'orca-grant-ownership.txt')
  const grants = new RuntimeTerminalFileGrants({
    resolveRuntimeFileTarget: async () => ({
      worktree: { id: 'folder-1' },
      executionHostId: 'local'
    })
  })
  const grant = grants.createTerminalFileGrant({
    worktreeId: 'folder-1',
    absolutePath: artifactPath,
    clientId: 'client-a',
    stats: { dev: 1, ino: 2, nlink: 1, size: 12, mtimeMs: 3 }
  })
  await grants.requireTerminalFileGrant('folder-1', grant.id, artifactPath, 'client-a')

  grants.revokeTerminalFileGrantsForClient('client-a')
  grants.refreshTerminalFileGrant(grant)

  await expect(
    grants.requireTerminalFileGrant('folder-1', grant.id, artifactPath, 'client-a')
  ).rejects.toThrow('terminal_file_grant_expired')
})
