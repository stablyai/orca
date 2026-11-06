import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeAppEnvironment } from '../../../../config/scripts/test-runtime/environment/vitest-host-ports-setup'

let userDataDir: string

const { removeHostTreeMock, deleteWslFishHistoryFileMock } = vi.hoisted(() => ({
  removeHostTreeMock: vi.fn<(dir: string) => Promise<void>>(),
  deleteWslFishHistoryFileMock: vi.fn<(distro: string, session: string) => Promise<string | void>>()
}))

vi.mock('../../filesystem/host-tree-removal', () => ({
  removeHostTree: removeHostTreeMock
}))

vi.mock('../../wsl/history/wsl-fish-history-cleanup', () => ({
  deleteWslFishHistoryFile: deleteWslFishHistoryFileMock
}))

import { hashWorktreeId } from './terminal-history-id'
import { fishHistorySessionName } from './fish-history-session'
import {
  cancelPendingHistoryTreeRemovalRetries,
  deleteWorktreeHistoryDir,
  flushPendingWorktreeHistoryDeletions,
  schedulePendingHistoryTreeRemovals
} from './terminal-history-deletion'
import {
  _resetWslBackgroundDistroGateForTests,
  noteWslDistrosRunning
} from '../../wsl/discovery/wsl-background-distro-gate'

// Real filesystem reads need the actual event loop, even while timers are faked.
const realSetImmediate = setImmediate

async function settleTombstoneDirectoryReads(): Promise<void> {
  for (let index = 0; index < 10; index++) {
    await new Promise((resolve) => realSetImmediate(resolve))
  }
}

describe('tombstoned history removal retries', () => {
  beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'orca-history-retry-'))
    installFakeAppEnvironment({ getPath: () => userDataDir })
    removeHostTreeMock.mockReset()
    deleteWslFishHistoryFileMock.mockReset()
    deleteWslFishHistoryFileMock.mockResolvedValue(undefined)
    removeHostTreeMock.mockImplementation(async (dir) => {
      rmSync(dir, { recursive: true, force: true })
    })
    vi.useFakeTimers()
  })

  afterEach(() => {
    cancelPendingHistoryTreeRemovalRetries()
    _resetWslBackgroundDistroGateForTests()
    vi.useRealTimers()
    rmSync(userDataDir, { recursive: true, force: true })
  })

  it('keeps the tombstone while its distro is stopped and finishes once the distro runs', async () => {
    const distroRoot = join(userDataDir, 'terminal-history-wsl', 'Ubuntu')
    mkdirSync(distroRoot, { recursive: true })
    deleteWslFishHistoryFileMock.mockResolvedValueOnce('distro-stopped')
    const worktreeId = 'repo-1::/path/stopped-distro'
    const dir = join(distroRoot, hashWorktreeId(worktreeId))
    mkdirSync(dir, { recursive: true })
    const fishSession = fishHistorySessionName(hashWorktreeId(worktreeId))
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({ worktreeId, fishSession }))

    deleteWorktreeHistoryDir(worktreeId)
    await flushPendingWorktreeHistoryDeletions()

    expect(removeHostTreeMock).not.toHaveBeenCalled()
    expect(readdirSync(join(distroRoot, '.pending-delete'))).toHaveLength(1)

    await schedulePendingHistoryTreeRemovals(distroRoot)
    await settleTombstoneDirectoryReads()
    expect(deleteWslFishHistoryFileMock).toHaveBeenCalledTimes(1)

    deleteWslFishHistoryFileMock.mockResolvedValue('deleted')
    noteWslDistrosRunning(['ubuntu'])
    await flushPendingWorktreeHistoryDeletions()

    expect(deleteWslFishHistoryFileMock).toHaveBeenLastCalledWith('Ubuntu', fishSession)
    expect(removeHostTreeMock).toHaveBeenCalledTimes(1)
    expect(readdirSync(join(distroRoot, '.pending-delete'))).toHaveLength(0)
  })
})
