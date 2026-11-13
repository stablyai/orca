import { GitAdmissionScheduler } from '../../../../shared/git/admission/git-admission-scheduler'
import {
  acquireGitAdmission,
  _resetGitAdmissionForTests
} from '../../../git/command-runner/admission/git-subprocess-admission'
import { worktreeRemovalLifetime } from '../../../workspaces/removal/worktree-removal-lifetime'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { GitWorktreeInfo } from '../../../../shared/worktree/types'
import type { RuntimeStore } from '../../construction/runtime-store-contract'
import type { WorktreeRemovalRecord } from '../../../workspaces/removal/worktree-removal-records'

const { scan } = vi.hoisted(() => ({ scan: vi.fn() }))
vi.mock('../../../git/worktrees/catalog/worktree-listing', () => ({
  listWorktreesStrict: scan,
  listWorktreeGraph: vi.fn(),
  annotateSparseCheckoutStatus: vi.fn()
}))
vi.mock('../../../git/worktrees/removal/worktree-removal', () => ({
  finishUnregisteredWorktreeRemoval: async () => ({}),
  deleteBranchOfUnregisteredWorktree: vi.fn(),
  removeWorktree: vi.fn()
}))
vi.mock('../../../ipc/worktree-remote', () => ({
  cleanupUnusedWorktreePushTargetRemote: async () => {}
}))
vi.mock('./runtime-registered-local-worktree-removal', () => ({
  cleanupRemovedWorktreePushTarget: async () => {},
  finishRuntimeLocalWorktreeRemoval: vi.fn()
}))
vi.mock('../../../workspaces/execution-host/project-runtime-git-options', () => ({
  getLocalProjectWorktreeGitOptions: () => ({})
}))
import { interruptedLocalWorktreeRemovalJob } from './runtime-interrupted-local-worktree-removal'
import {
  _resetWorktreeScanCacheForTests,
  bumpWorktreeScanGeneration
} from '../../../git/worktrees/catalog/worktree-scan-cache'
import {
  _resetPendingWorktreeRemovalsForTests,
  _settlePendingWorktreeRemovalsForTests,
  resumeInterruptedWorktreeRemovals
} from '../../../workspaces/removal/worktree-background-removal'
import { prepareWorktreeRemovalsForStore } from '../../../workspaces/removal/worktree-removal-records-load'
import {
  writeWorktreeRemovalRecords,
  readWorktreeRemovalRecords
} from '../../../workspaces/removal/worktree-removal-records'

let directory = ''
afterEach(async () => {
  _resetPendingWorktreeRemovalsForTests()
  _resetWorktreeScanCacheForTests()
  scan.mockReset()
  _resetGitAdmissionForTests()
  if (directory) {
    await rm(directory, { recursive: true, force: true })
  }
  directory = ''
})
function record(index: number, repoId: string): WorktreeRemovalRecord {
  return {
    worktreeId: `${repoId}::${index}`,
    repoId,
    repoPath: `/missing/${repoId}`,
    worktreePath: `/missing/${repoId}/checkout-${index}`,
    branch: 'feature',
    head: 'abc',
    force: false,
    deleteBranch: false,
    requestedAt: 1
  }
}
function host(repos: Repo[]) {
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: interrupted cleanup consumes only these repo and metadata reads; physical Git mutations are isolated below the scan seam.
    store: {
      getRepos: () => repos,
      getRepo: (id: string) => repos.find((repo) => repo.id === id),
      getWorktreeMeta: () => undefined
    } as unknown as RuntimeStore,
    acquireWatcherRemoval: async () => ({ finish: async () => {} }),
    closeWatchers: async () => {},
    preservedBranchCleanup: { preserveHead: () => ({}), remember: () => {} },
    purge: vi.fn(async (_record: WorktreeRemovalRecord) => {}),
    onRemoved: vi.fn(),
    publish: () => {}
  }
}

it.each([10, 100])(
  'shares the two owning repo inventories while completing %i saved removals',
  async (population) => {
    directory = await mkdtemp(join(tmpdir(), 'orca-recovery-scan-contract-'))
    const repos = [0, 1].map((i) => ({
      id: `repo-${i}`,
      path: `/missing/repo-${i}`,
      displayName: 'repo',
      badgeColor: '',
      addedAt: 0
    }))
    const records = Array.from({ length: population }, (_, index) =>
      record(index, `repo-${index % 2}`)
    )
    await writeWorktreeRemovalRecords(directory, () => records)
    await prepareWorktreeRemovalsForStore({
      getProfileStorageDirectory: () => directory,
      getRepos: () => repos
    })
    let release!: () => void
    const reading = new Promise<void>((resolve) => {
      release = resolve
    })
    scan.mockImplementation(async () => {
      await reading
      return []
    })
    const runtime = host(repos)
    resumeInterruptedWorktreeRemovals((saved) => interruptedLocalWorktreeRemovalJob(saved, runtime))
    // Each distinct repo needs one authoritative inventory; pending rows cannot require duplicate concurrent reads.
    await vi.waitFor(() => expect(scan).toHaveBeenCalledTimes(2))
    release()
    await _settlePendingWorktreeRemovalsForTests()
    expect(runtime.purge.mock.calls.map(([saved]) => saved.worktreeId).sort()).toEqual(
      records.map((saved) => saved.worktreeId).sort()
    )
    expect(await readWorktreeRemovalRecords(directory)).toEqual([])
  }
)

it('obtains a fresh inventory after a catalog generation changes and protects the replacement checkout', async () => {
  const saved = record(0, 'repo-0')
  const runtime = host([
    { id: 'repo-0', path: saved.repoPath, displayName: 'repo', badgeColor: '', addedAt: 0 }
  ])
  let release!: () => void
  const oldInventory = new Promise<GitWorktreeInfo[]>((resolve) => {
    release = () => resolve([])
  })
  scan.mockReturnValueOnce(oldInventory).mockResolvedValueOnce([
    {
      path: saved.worktreePath,
      branch: 'replacement',
      head: 'def',
      isMainWorktree: false,
      isBare: false
    }
  ])
  const signal = new AbortController().signal
  const first = interruptedLocalWorktreeRemovalJob(saved, runtime).run(signal)
  bumpWorktreeScanGeneration(saved.repoPath)
  const replacement = interruptedLocalWorktreeRemovalJob(saved, runtime).run(signal)
  await expect(replacement).rejects.toThrow('A different checkout is now at')
  expect(scan).toHaveBeenCalledTimes(2)
  expect(runtime.purge).not.toHaveBeenCalled()
  release()
  await first
})

it.each([10, 100])(
  'cancels queued recovery before spawning an inventory and preserves %i accepted records',
  async (population) => {
    directory = await mkdtemp(join(tmpdir(), 'orca-recovery-cancel-'))
    _resetGitAdmissionForTests(new GitAdmissionScheduler({ generalCap: 1, generalHeadroom: 0 }))
    const blocker = await acquireGitAdmission({
      args: ['status'],
      cwd: '/held',
      tier: 'background'
    })
    const repos = [
      { id: 'repo-0', path: '/missing/repo-0', displayName: 'repo', badgeColor: '', addedAt: 0 }
    ]
    const records = Array.from({ length: population }, (_, index) => record(index, 'repo-0'))
    const spawn = vi.fn()
    scan.mockImplementation(async (cwd: string, options: { signal: AbortSignal }) => {
      const grant = await acquireGitAdmission({
        args: ['worktree', 'list', '--porcelain'],
        cwd,
        signal: options.signal,
        tier: 'background'
      })
      try {
        spawn()
        return []
      } finally {
        grant.release()
      }
    })
    try {
      await writeWorktreeRemovalRecords(directory, () => records)
      await prepareWorktreeRemovalsForStore({
        getProfileStorageDirectory: () => directory,
        getRepos: () => repos
      })
      const runtime = host(repos)
      resumeInterruptedWorktreeRemovals((saved) =>
        interruptedLocalWorktreeRemovalJob(saved, runtime)
      )
      await vi.waitFor(() => expect(scan).toHaveBeenCalledOnce())
      await worktreeRemovalLifetime.close()
      expect(spawn).not.toHaveBeenCalled()
      expect(runtime.purge).not.toHaveBeenCalled()
      expect(
        (await readWorktreeRemovalRecords(directory)).map((saved) => saved.worktreeId).sort()
      ).toEqual(records.map((saved) => saved.worktreeId).sort())
    } finally {
      blocker.release()
    }
  }
)
