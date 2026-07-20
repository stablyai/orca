import { execFileSync } from 'node:child_process'
import {
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitWorktreeInfo } from '../../shared/types'
import { ensureMissionRoot, removeMissionRoot } from './mission-root'
import {
  clearMissionWorktreeCreateIntent,
  readMissionWorktreeCreateIntent,
  recoverMissionWorktreeCreateIntent,
  writeMissionWorktreeCreateIntent,
  type MissionRootOwnership
} from './mission-worktree-create-intent'
import { readMissionWorktreeOwnershipMarker } from './mission-worktree-ownership-marker'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<
    Record<string, unknown> & {
      fsyncSync: typeof fsyncSync
      linkSync: typeof linkSync
      openSync: typeof openSync
    }
  >()
  return {
    ...actual,
    fsyncSync: vi.fn(actual.fsyncSync),
    linkSync: vi.fn(actual.linkSync),
    openSync: vi.fn(actual.openSync)
  }
})

let temporaryDirectory: string
let repoPath: string
let root: MissionRootOwnership

function git(args: string[], cwd = repoPath): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function makeWorktree(pathValue: string, branchName: string): GitWorktreeInfo {
  return {
    path: pathValue,
    head: git(['rev-parse', 'HEAD'], pathValue).trim(),
    branch: `refs/heads/${branchName}`,
    isBare: false,
    isMainWorktree: false
  }
}

function writeIntent(args: {
  branchName: string
  worktreePath: string
  preserveBranchOnDelete?: boolean
}) {
  return writeMissionWorktreeCreateIntent({
    root,
    repoId: 'repo-1',
    branchName: args.branchName,
    worktreePath: args.worktreePath,
    worktreeInstanceId: 'instance-1',
    preserveBranchOnDelete: args.preserveBranchOnDelete ?? false
  })
}

beforeEach(() => {
  const temporaryBase = process.platform === 'darwin' ? '/tmp' : os.tmpdir()
  temporaryDirectory = mkdtempSync(path.join(temporaryBase, 'mission-create-intent-'))
  repoPath = path.join(temporaryDirectory, 'repo')
  mkdirSync(repoPath)
  git(['init'])
  git(['config', 'user.email', 'intent@example.com'])
  git(['config', 'user.name', 'Mission Intent Test'])
  writeFileSync(path.join(repoPath, 'README.md'), 'initial\n')
  git(['add', 'README.md'])
  git(['commit', '-m', 'initial'])
  root = {
    baseDir: path.join(temporaryDirectory, 'missions'),
    rootPath: path.join(temporaryDirectory, 'missions', 'mission-1'),
    missionId: 'mission-1'
  }
  ensureMissionRoot({ ...root, links: [] })
  vi.clearAllMocks()
})

afterEach(() => {
  rmSync(temporaryDirectory, { recursive: true, force: true })
})

describe('Mission worktree create intent', () => {
  it.skipIf(process.platform === 'win32')(
    'fsyncs the parent directory after publishing an intent on POSIX',
    () => {
      const worktreePath = path.join(root.rootPath, 'repo-durable')

      writeIntent({ branchName: 'mission/durable', worktreePath })

      expect(vi.mocked(openSync).mock.calls).toHaveLength(2)
      expect(vi.mocked(openSync).mock.calls[1]).toEqual([root.rootPath, 'r'])
      expect(vi.mocked(fsyncSync)).toHaveBeenCalledTimes(2)
      expect(vi.mocked(linkSync).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(fsyncSync).mock.invocationCallOrder[1]
      )
    }
  )

  it('does not require unsupported directory fsync when publishing on Windows', () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    if (!platformDescriptor) {
      throw new Error('process_platform_descriptor_missing')
    }
    Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'win32' })
    try {
      const worktreePath = path.join(root.rootPath, 'repo-windows')

      const intent = writeIntent({ branchName: 'mission/windows', worktreePath })

      expect(readMissionWorktreeCreateIntent(root, 'repo-1')).toEqual(intent)
      expect(vi.mocked(openSync)).toHaveBeenCalledTimes(1)
      expect(vi.mocked(fsyncSync)).toHaveBeenCalledTimes(1)
      expect(vi.mocked(linkSync)).toHaveBeenCalledTimes(1)
    } finally {
      Object.defineProperty(process, 'platform', platformDescriptor)
    }
  })

  it('adopts an add-complete checkout and publishes its ownership marker', () => {
    const worktreePath = path.join(root.rootPath, 'repo-1')
    writeIntent({ branchName: 'mission/task', worktreePath })
    git(['worktree', 'add', '-b', 'mission/task', worktreePath, 'HEAD'])

    const proof = recoverMissionWorktreeCreateIntent({
      root,
      repoId: 'repo-1',
      repoPath,
      branchName: 'mission/task',
      worktrees: [makeWorktree(worktreePath, 'mission/task')]
    })

    expect(proof).toEqual({
      missionId: 'mission-1',
      repoId: 'repo-1',
      worktreeId: `repo-1::${worktreePath}`,
      worktreeInstanceId: 'instance-1'
    })
    expect(readMissionWorktreeOwnershipMarker({ repoPath, worktreePath })).toEqual(proof)
    expect(readMissionWorktreeCreateIntent(root, 'repo-1')).toBeNull()
  })

  it('carries reused-branch preservation into the durable ownership marker', () => {
    const worktreePath = path.join(root.rootPath, 'repo-reused')
    git(['branch', 'mission/reused'])
    writeIntent({
      branchName: 'mission/reused',
      worktreePath,
      preserveBranchOnDelete: true
    })
    git(['worktree', 'add', worktreePath, 'mission/reused'])

    const proof = recoverMissionWorktreeCreateIntent({
      root,
      repoId: 'repo-1',
      repoPath,
      branchName: 'mission/reused',
      worktrees: [makeWorktree(worktreePath, 'mission/reused')]
    })

    expect(proof?.preserveBranchOnDelete).toBe(true)
    expect(
      readMissionWorktreeOwnershipMarker({ repoPath, worktreePath })?.preserveBranchOnDelete
    ).toBe(true)
  })

  it.skipIf(process.platform !== 'darwin')(
    'recovers a Git row that canonicalizes /tmp through /private/tmp',
    () => {
      const worktreePath = path.join(root.rootPath, 'repo-alias')
      writeIntent({ branchName: 'mission/alias', worktreePath })
      git(['worktree', 'add', '-b', 'mission/alias', worktreePath, 'HEAD'])
      const canonicalWorktreePath = realpathSync(worktreePath)
      expect(worktreePath).toMatch(/^\/tmp\//)
      expect(canonicalWorktreePath).toMatch(/^\/private\/tmp\//)

      const proof = recoverMissionWorktreeCreateIntent({
        root,
        repoId: 'repo-1',
        repoPath,
        branchName: 'mission/alias',
        worktrees: [
          {
            ...makeWorktree(worktreePath, 'mission/alias'),
            path: canonicalWorktreePath
          }
        ]
      })

      expect(proof?.worktreeId).toBe(`repo-1::${canonicalWorktreePath}`)
      expect(
        readMissionWorktreeOwnershipMarker({
          repoPath,
          worktreePath: canonicalWorktreePath
        })
      ).toEqual(proof)
    }
  )

  it('clears an add-not-started intent when both Git registration and target are absent', () => {
    const worktreePath = path.join(root.rootPath, 'never-added')
    writeIntent({ branchName: 'mission/not-started', worktreePath })

    expect(
      recoverMissionWorktreeCreateIntent({
        root,
        repoId: 'repo-1',
        repoPath,
        branchName: 'mission/not-started',
        worktrees: []
      })
    ).toBeNull()
    expect(readMissionWorktreeCreateIntent(root, 'repo-1')).toBeNull()
  })

  it('fails closed without deleting an unregistered target directory', () => {
    const worktreePath = path.join(root.rootPath, 'partial-or-user-data')
    mkdirSync(worktreePath)
    writeFileSync(path.join(worktreePath, 'keep.txt'), 'keep')
    writeIntent({ branchName: 'mission/partial', worktreePath })

    expect(() =>
      recoverMissionWorktreeCreateIntent({
        root,
        repoId: 'repo-1',
        repoPath,
        branchName: 'mission/partial',
        worktrees: []
      })
    ).toThrow('mission_member_worktree_create_recovery_unverified')
    expect(readFileSync(path.join(worktreePath, 'keep.txt'), 'utf8')).toBe('keep')
    expect(readMissionWorktreeCreateIntent(root, 'repo-1')).not.toBeNull()
  })

  it('rejects a Git row on a different branch and retains the intent for inspection', () => {
    const worktreePath = path.join(root.rootPath, 'wrong-branch')
    mkdirSync(worktreePath)
    writeIntent({ branchName: 'mission/expected', worktreePath })

    expect(() =>
      recoverMissionWorktreeCreateIntent({
        root,
        repoId: 'repo-1',
        repoPath,
        branchName: 'mission/expected',
        worktrees: [
          {
            path: worktreePath,
            head: 'abc',
            branch: 'refs/heads/mission/other',
            isBare: false,
            isMainWorktree: false
          }
        ]
      })
    ).toThrow('mission_member_worktree_create_recovery_unverified')
    expect(readMissionWorktreeCreateIntent(root, 'repo-1')).not.toBeNull()
  })

  it('does not replace an unresolved prior operation for the same repo', () => {
    const worktreePath = path.join(root.rootPath, 'first')
    const first = writeIntent({ branchName: 'mission/first', worktreePath })

    expect(() => writeIntent({ branchName: 'mission/second', worktreePath })).toThrow(
      'mission_member_worktree_create_intent_write_failed'
    )
    expect(readMissionWorktreeCreateIntent(root, 'repo-1')).toEqual(first)
  })

  it('lets Mission root teardown remove an otherwise ghost intent-only root', () => {
    const intent = writeIntent({
      branchName: 'mission/not-started',
      worktreePath: path.join(root.rootPath, 'never-added')
    })

    clearMissionWorktreeCreateIntent({ root, intent })
    expect(removeMissionRoot(root)).toEqual({ removed: true, preservedEntries: [] })
    expect(existsSync(root.rootPath)).toBe(false)
  })
})
