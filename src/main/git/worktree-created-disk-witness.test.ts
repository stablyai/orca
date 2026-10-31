import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./worktree-list-reader', () => ({
  readRepoLocation: vi.fn(),
  readRepoCommonDirFromGit: vi.fn(),
  readCheckedOutBranchRef: vi.fn(),
  readWorktreeHeadOid: vi.fn(),
  readTranslatedWorktreeGraph: vi.fn(),
  readWorktreeList: vi.fn()
}))
vi.mock('./worktree-sparse-checkout-cache', () => ({
  detectSparseCheckoutCached: vi.fn(async () => false)
}))

import { describeCreatedWorktree } from './worktree-listing'
import {
  readCheckedOutBranchRef,
  readRepoCommonDirFromGit,
  readRepoLocation,
  readWorktreeHeadOid
} from './worktree-list-reader'

const readRepoLocationMock = vi.mocked(readRepoLocation)
const readRepoCommonDirFromGitMock = vi.mocked(readRepoCommonDirFromGit)
const readCheckedOutBranchRefMock = vi.mocked(readCheckedOutBranchRef)
const readWorktreeHeadOidMock = vi.mocked(readWorktreeHeadOid)

// Root bypasses mode bits; chmod cannot simulate denied reads there.
const CAN_DENY_READ = process.platform !== 'win32' && process.getuid?.() !== 0

let scratchDir = ''
let repoPath = ''
let worktreePath = ''

// Canonicalize macOS /var-to-/private/var temp paths just as the witness does.
beforeEach(() => {
  scratchDir = realpathSync(mkdtempSync(join(tmpdir(), 'orca-created-witness-')))
  repoPath = join(scratchDir, 'repo')
  worktreePath = join(scratchDir, 'workspaces', 'feature')
  mkdirSync(repoPath, { recursive: true })
  readRepoLocationMock.mockResolvedValue({
    topLevel: worktreePath,
    commonDir: join(scratchDir, 'elsewhere', '.git'),
    gitDir: join(scratchDir, 'elsewhere', '.git', 'worktrees', 'feature')
  })
  readRepoCommonDirFromGitMock.mockResolvedValue(join(scratchDir, 'other-repo', '.git'))
  readCheckedOutBranchRefMock.mockResolvedValue('refs/heads/feature')
  readWorktreeHeadOidMock.mockResolvedValue('a'.repeat(40))
})

afterEach(() => {
  vi.clearAllMocks()
  chmodSync(repoPath, 0o700)
  rmSync(scratchDir, { recursive: true, force: true })
})

describe('describeCreatedWorktree when Git and the repo disagree', () => {
  it('reports nothing when the witness proves a different object store', async () => {
    const otherGitDir = join(scratchDir, 'other-repo', '.git')
    mkdirSync(otherGitDir, { recursive: true })
    writeFileSync(join(repoPath, '.git'), `gitdir: ${otherGitDir}\n`)
    await expect(
      describeCreatedWorktree(repoPath, worktreePath, 'feature')
    ).resolves.toBeUndefined()
  })

  it('throws when the .git marker points at a path that does not exist', async () => {
    writeFileSync(join(repoPath, '.git'), `gitdir: ${join(scratchDir, 'gone', '.git')}\n`)
    await expect(describeCreatedWorktree(repoPath, worktreePath, 'feature')).rejects.toMatchObject({
      message: expect.stringContaining('gitdir marker target unreadable')
    })
  })

  it('throws when the .git marker points at a file', async () => {
    const notAGitDir = join(scratchDir, 'not-a-git-dir')
    writeFileSync(notAGitDir, 'not a git dir\n')
    writeFileSync(join(repoPath, '.git'), `gitdir: ${notAGitDir}\n`)
    await expect(describeCreatedWorktree(repoPath, worktreePath, 'feature')).rejects.toMatchObject({
      message: expect.stringContaining('gitdir marker target is not a directory')
    })
  })

  it('reports nothing for a bare repo, whose missing .git is a real answer', async () => {
    await expect(
      describeCreatedWorktree(repoPath, worktreePath, 'feature')
    ).resolves.toBeUndefined()
  })

  it('follows gitdir and commondir markers', async () => {
    const commonDir = join(scratchDir, 'main', '.git')
    const linkedGitDir = join(commonDir, 'worktrees', 'source')
    mkdirSync(linkedGitDir, { recursive: true })
    writeFileSync(join(repoPath, '.git'), `gitdir: ${linkedGitDir}\n`)
    writeFileSync(join(linkedGitDir, 'commondir'), '../..\n')
    readRepoLocationMock.mockResolvedValue({
      topLevel: worktreePath,
      commonDir,
      gitDir: join(commonDir, 'worktrees', 'feature')
    })

    await expect(describeCreatedWorktree(repoPath, worktreePath, 'feature')).resolves.toMatchObject(
      {
        branch: 'refs/heads/feature'
      }
    )
  })

  it.skipIf(!CAN_DENY_READ)('throws when the .git marker exists but cannot be read', async () => {
    const dotGit = join(repoPath, '.git')
    writeFileSync(dotGit, 'gitdir: /somewhere\n')
    chmodSync(dotGit, 0o000)
    await expect(describeCreatedWorktree(repoPath, worktreePath, 'feature')).rejects.toMatchObject({
      message: expect.stringMatching(/^repo common dir unverifiable: could not read .*\.git: /),
      cause: expect.objectContaining({ code: 'EACCES' })
    })
  })
})

describe('describeCreatedWorktree before the witness is reached', () => {
  it('never pays for the disk read when Git already agreed', async () => {
    const commonDir = join(repoPath, '.git')
    mkdirSync(commonDir, { recursive: true })
    readRepoLocationMock.mockResolvedValue({
      topLevel: worktreePath,
      commonDir,
      gitDir: join(commonDir, 'worktrees', 'feature')
    })
    readRepoCommonDirFromGitMock.mockResolvedValue(commonDir)
    if (CAN_DENY_READ) {
      chmodSync(repoPath, 0o000)
    }
    await expect(describeCreatedWorktree(repoPath, worktreePath, 'feature')).resolves.toMatchObject(
      {
        branch: 'refs/heads/feature'
      }
    )
  })
})
