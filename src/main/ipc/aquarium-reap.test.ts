import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { execSync } from 'child_process'
import { reapAquariumWorktrees } from './aquarium-reap'

function makeGhostRepo(): { root: string; wt1: string; wt2: string } {
  const root = mkdtempSync(join(tmpdir(), 'aquarium-reap-'))
  execSync('git init -q && git config user.email t@t.t && git config user.name t', { cwd: root })
  execSync('echo base > f && git add f && git commit -qm base', { cwd: root })
  const wt1 = join(root, 'wt1')
  const wt2 = join(root, 'wt2')
  execSync(`git worktree add -q ${wt1} -b feat1`, { cwd: root })
  execSync(`git worktree add -q ${wt2} -b feat2`, { cwd: root })
  // simulate "ghost": delete the checkout dirs out from under git
  rmSync(wt1, { recursive: true, force: true })
  rmSync(wt2, { recursive: true, force: true })
  return { root, wt1, wt2 }
}

describe('reapAquariumWorktrees', () => {
  let repo: { root: string; wt1: string; wt2: string }
  beforeEach(() => {
    repo = makeGhostRepo()
  })
  afterEach(() => {
    try {
      rmSync(repo.root, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('reaps ghost worktrees and evaporates the admin stubs', async () => {
    const res = await reapAquariumWorktrees({
      repoPath: repo.root,
      worktreePaths: [repo.wt1, repo.wt2]
    })
    expect(res.reaped.sort()).toEqual([repo.wt1, repo.wt2].sort())
    expect(res.denied).toEqual([])
    expect(res.failed).toEqual([])

    // proof the SYSTEM is valid: git no longer lists them
    const list = execSync('git worktree list --porcelain', { cwd: repo.root }).toString()
    expect(list).not.toContain('wt1')
    expect(list).not.toContain('wt2')
    // proof the orphaned .git/worktrees stub is gone
    const stubs = execSync(`ls ${repo.root}/.git/worktrees 2>/dev/null || true`)
      .toString()
      .trim()
    expect(stubs).toBe('')
  })

  it('refuses a path that is not a known worktree (not-found)', async () => {
    const missing = join(repo.root, 'does-not-exist')
    const res = await reapAquariumWorktrees({
      repoPath: repo.root,
      worktreePaths: [missing]
    })
    expect(res.reaped).toEqual([])
    expect(res.denied).toEqual([{ path: missing, reason: 'not-found' }])
  })

  it('refuses a path the local owner check rejects (owner-uid)', async () => {
    const res = await reapAquariumWorktrees(
      { repoPath: repo.root, worktreePaths: [repo.wt1] },
      { isOwnedByLocal: () => false }
    )
    expect(res.reaped).toEqual([])
    expect(res.denied).toEqual([{ path: repo.wt1, reason: 'owner-uid' }])
    // not removed
    const list = execSync('git worktree list --porcelain', { cwd: repo.root }).toString()
    expect(list).toContain('wt1')
  })
})
