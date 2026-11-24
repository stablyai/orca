import { mkdir, mkdtemp, rm, utimes } from 'node:fs/promises'
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

// Fixed, distinct timestamps stand in for a clock that advances between probes.
let clock = 1_700_000_000
async function advanceClock(repo: string): Promise<void> {
  clock += 10
  for (const dir of [path.join(repo, '.git', 'worktrees'), path.join(repo, '.git')]) {
    await utimes(dir, clock, clock).catch(() => {})
  }
}

describe('readRepoWorktreeReconcileProbe', () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  it('differs after a worktree is added and removed when none existed', async () => {
    const repo = await makeRepo()
    await advanceClock(repo)
    const before = await readRepoWorktreeReconcileProbe(repo)
    await advanceClock(repo)
    await mkdir(path.join(repo, '.git', 'worktrees', 'tmp'), { recursive: true })
    await advanceClock(repo)
    await rm(path.join(repo, '.git', 'worktrees'), { recursive: true })
    await advanceClock(repo)
    const after = await readRepoWorktreeReconcileProbe(repo)
    expect(before).not.toBeNull()
    expect(after).not.toBe(before)
  })

  it('differs after a worktree is added and removed beside an existing one', async () => {
    const repo = await makeRepo()
    await mkdir(path.join(repo, '.git', 'worktrees', 'keep'), { recursive: true })
    await advanceClock(repo)
    const before = await readRepoWorktreeReconcileProbe(repo)
    await advanceClock(repo)
    await mkdir(path.join(repo, '.git', 'worktrees', 'tmp'))
    await advanceClock(repo)
    await rm(path.join(repo, '.git', 'worktrees', 'tmp'), { recursive: true })
    await advanceClock(repo)
    const after = await readRepoWorktreeReconcileProbe(repo)
    expect(after).not.toBe(before)
  })
})
