import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RuntimeTerminalFileGrants } from './file-grants'

const artifactPath = join(tmpdir(), 'orca-grant-ownership.txt')

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
  it('never reinserts a revoked grant when in-flight access refreshes it', async () => {
    const { grants } = createGrants()
    const grant = mint(grants, 'client-a')
    grants.revokeTerminalFileGrantsForClient('client-a')
    grants.refreshTerminalFileGrant(grant)
    await expect(
      grants.requireTerminalFileGrant('folder-1', grant.id, artifactPath, 'client-a')
    ).rejects.toThrow('terminal_file_grant_expired')
  })
})
