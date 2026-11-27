import { mkdtemp, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTempDirs } from '../../../../shared/testing/remove-temp-dirs.test-support'
import { gitExecFileAsync } from '../../../git/command-runner/git-exec-file'
import { readLocalGitConfigSignature } from '../../repositories/local-git-config-signature'
import {
  doesTrackedUpstreamCacheConfigSignatureMatch,
  resolveTrackedUpstreamBranchCacheKey,
  type TrackedUpstreamSnapshotCacheEntry
} from './tracked-upstream-cache'

const roots: string[] = []
afterEach(async () => {
  await removeTempDirs(roots.splice(0))
})

async function git(cwd: string, ...argv: string[]): Promise<string> {
  return (await gitExecFileAsync(argv, { cwd })).stdout.trim()
}

async function repoWithWorktree(): Promise<{ repoPath: string; worktreePath: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orca-tracked-upstream-')))
  roots.push(root)
  await git(root, 'init', '--quiet', 'repo')
  const repoPath = join(root, 'repo')
  await git(repoPath, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  await git(repoPath, 'config', 'user.name', 'Tracked Upstream Test')
  await git(repoPath, 'config', 'user.email', 'test@example.com')
  await git(repoPath, 'config', 'core.hooksPath', join(root, 'no-hooks'))
  await git(repoPath, 'commit', '--quiet', '--allow-empty', '-m', 'base')
  await git(repoPath, 'worktree', 'add', '--quiet', '-b', 'feature', join(root, 'wt'))
  return { repoPath, worktreePath: join(root, 'wt') }
}

async function readSignature(repoPath: string): Promise<string> {
  const signature = await readLocalGitConfigSignature({ repoPath, connectionId: null })
  if (!signature) {
    throw new Error('Expected a local git config signature')
  }
  return signature
}

function entryWithSignature(
  signature: string,
  signatureRepoPath?: string
): TrackedUpstreamSnapshotCacheEntry {
  return {
    expiresAt: Date.now() + 60_000,
    gitConfigSignature: signature,
    ...(signatureRepoPath ? { gitConfigSignatureRepoPath: signatureRepoPath } : {}),
    upstreamsByBranchName: new Map()
  }
}

describe('resolveTrackedUpstreamBranchCacheKey', () => {
  it('shares one key across worktrees of the same local repository', async () => {
    const { repoPath, worktreePath } = await repoWithWorktree()
    const repoKey = await resolveTrackedUpstreamBranchCacheKey(repoPath)
    const worktreeKey = await resolveTrackedUpstreamBranchCacheKey(worktreePath)
    expect(worktreeKey).toBe(repoKey)
  })

  it('keeps per-path keys for SSH connections', async () => {
    const { repoPath, worktreePath } = await repoWithWorktree()
    const repoKey = await resolveTrackedUpstreamBranchCacheKey(repoPath, 'conn-1')
    const worktreeKey = await resolveTrackedUpstreamBranchCacheKey(worktreePath, 'conn-1')
    expect(worktreeKey).not.toBe(repoKey)
  })
})

describe('doesTrackedUpstreamCacheConfigSignatureMatch', () => {
  it('serves an entry recorded in one worktree to lookups from another', async () => {
    const { repoPath, worktreePath } = await repoWithWorktree()
    const entry = entryWithSignature(await readSignature(repoPath), repoPath)
    await expect(doesTrackedUpstreamCacheConfigSignatureMatch(entry, worktreePath)).resolves.toBe(
      true
    )
  })

  it('signatures embed per-worktree paths, so entries without a recorded path cannot match cross-worktree', async () => {
    const { repoPath, worktreePath } = await repoWithWorktree()
    const entry = entryWithSignature(await readSignature(repoPath))
    await expect(doesTrackedUpstreamCacheConfigSignatureMatch(entry, worktreePath)).resolves.toBe(
      false
    )
  })

  it('still invalidates when the shared repository config changes', async () => {
    const { repoPath, worktreePath } = await repoWithWorktree()
    const entry = entryWithSignature(await readSignature(repoPath), repoPath)
    await git(repoPath, 'config', 'remote.pushdefault', 'origin')
    await expect(doesTrackedUpstreamCacheConfigSignatureMatch(entry, worktreePath)).resolves.toBe(
      false
    )
  })
})
