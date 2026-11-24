import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readRepoWorktreeReconcileProbe } from './repo-worktree-admin-fingerprint'

const roots: string[] = []

async function makeRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'reconcile-probe-'))
  roots.push(root)
  await mkdir(path.join(root, '.git'))
  return root
}

// Filesystem timestamps are coarse on some platforms.
const pause = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30))

describe('readRepoWorktreeReconcileProbe', () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  it('differs after a worktree is added and removed when none existed', async () => {
    const repo = await makeRepo()
    const before = await readRepoWorktreeReconcileProbe(repo)
    await pause()
    await mkdir(path.join(repo, '.git', 'worktrees', 'tmp'), { recursive: true })
    await pause()
    await rm(path.join(repo, '.git', 'worktrees'), { recursive: true })
    await pause()
    const after = await readRepoWorktreeReconcileProbe(repo)
    expect(before).not.toBeNull()
    expect(after).not.toBe(before)
  })

  it('differs after a worktree is added and removed beside an existing one', async () => {
    const repo = await makeRepo()
    await mkdir(path.join(repo, '.git', 'worktrees', 'keep'), { recursive: true })
    await pause()
    const before = await readRepoWorktreeReconcileProbe(repo)
    await pause()
    await mkdir(path.join(repo, '.git', 'worktrees', 'tmp'))
    await pause()
    await rm(path.join(repo, '.git', 'worktrees', 'tmp'), { recursive: true })
    await pause()
    const after = await readRepoWorktreeReconcileProbe(repo)
    expect(after).not.toBe(before)
  })
})
