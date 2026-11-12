import { afterEach, expect, it, vi } from 'vitest'
import type * as FsPromises from 'node:fs/promises'
import type * as SnapshotReader from './branch-ref-snapshot-read'
import type * as DistroCatalog from '../wsl/discovery/distro-catalog'

const cwd = String.raw`C:\repo-linked`
const commonDir = String.raw`C:\repo-main\.git`
const gitDir = String.raw`C:\repo-main\.git\worktrees\linked`
const io = vi.hoisted(() => ({ remote: vi.fn(), refs: vi.fn() }))
vi.mock('../wsl/discovery/distro-catalog', async (original) => ({
  ...(await original<typeof DistroCatalog>()),
  listRunningWslDistrosAsync: async () => ['Ubuntu']
}))
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof FsPromises>()),
  realpath: async (path: string) => path,
  stat: async (path: string) => ({
    isFile: () => path.endsWith('.git'),
    isDirectory: () => !path.endsWith('.git'),
    dev: 1n,
    ino: 2n,
    birthtimeNs: 3n
  }),
  readFile: async () => String.raw`gitdir: C:\repo-main\.git\worktrees\linked`
}))
vi.mock('../../shared/git/metadata/git-common-directory', () => ({
  resolveGitCommonDirectory: async () => String.raw`C:\repo-main\.git`
}))
vi.mock('./source-control/resolve-git-dir', () => ({
  resolveGitDir: async () => String.raw`C:\repo-main\.git\worktrees\linked`
}))
vi.mock('./branch-ref-snapshot-read', async (original) => ({
  ...(await original<typeof SnapshotReader>()),
  readBranchRemoteNames: io.remote,
  readBranchRefSnapshot: io.refs
}))
import { searchBranchRefSnapshot, _resetBranchRefSnapshotsForTests } from './branch-ref-snapshot'
import {
  prepareWslLinkedWorktreeGitRouting,
  resetWslLinkedWorktreeGitRoutingForTests
} from './command-runner/host-routing/wsl-linked-worktree-git-routing'
import { resolveBranchSnapshotIdentity } from './branch-ref-snapshot-identity'
import { trackGitRefMutation } from './command-runner/git-ref-mutation-state'
import { subscribeGitRefChanges } from './refs/git-ref-change-signal'
import { _resetWslBackgroundDistroGateForTests } from '../wsl/discovery/wsl-background-distro-gate'

const platform = process.platform
afterEach(() => {
  _resetBranchRefSnapshotsForTests()
  resetWslLinkedWorktreeGitRoutingForTests()
  _resetWslBackgroundDistroGateForTests()
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  vi.restoreAllMocks()
  io.remote.mockReset()
  io.refs.mockReset()
})

it('keeps a live host snapshot across expiry of the filesystem-only linked-route proof', async () => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  const clock = vi.spyOn(Date, 'now').mockReturnValue(10_000)
  // The reader boundary models execution's existing route settlement; it is not a real WSL benchmark.
  io.remote.mockImplementation(async () => {
    await prepareWslLinkedWorktreeGitRouting(cwd, 'Ubuntu')
    return []
  })
  io.refs.mockResolvedValue({
    snapshot: {
      refs: [
        {
          refName: 'refs/heads/topic',
          label: 'topic',
          searchName: 'topic',
          oid: 'a'.repeat(40),
          committedAt: 0,
          symref: ''
        }
      ]
    },
    oversized: false
  })
  expect(await searchBranchRefSnapshot(cwd, 'topic', 20, true, { wslDistro: 'Ubuntu' })).toEqual([
    { refName: 'refs/heads/topic', localBranchName: 'topic' }
  ])
  clock.mockReturnValue(40_001)
  expect(await resolveBranchSnapshotIdentity(cwd, { wslDistro: 'Ubuntu' })).toMatchObject({
    commonDir,
    gitDir
  })
  expect(await searchBranchRefSnapshot(cwd, 'topic', 20, true, { wslDistro: 'Ubuntu' })).toEqual([
    { refName: 'refs/heads/topic', localBranchName: 'topic' }
  ])
  expect(io.remote).toHaveBeenCalledTimes(1)
  expect(io.refs).toHaveBeenCalledTimes(1)
  clock.mockReturnValue(70_002)
  const events: string[] = []
  const offOwner = subscribeGitRefChanges(commonDir, () => events.push('owner'))
  const offOther = subscribeGitRefChanges(String.raw`C:\other\.git`, () => events.push('other'))
  try {
    trackGitRefMutation(['commit'])()
    expect(events).toEqual(['owner', 'other', 'owner', 'other'])
  } finally {
    offOwner()
    offOther()
  }
})
