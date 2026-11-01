import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { writeWorktreeProfileMarker } from './dev-instance-isolation.mjs'
import { reclaimDevWorktreeProfiles } from './reclaim-dev-worktree-profiles.mjs'

const roots = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

it('removes only idle profiles whose worktree of this repository is gone', async () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'orca-dev-profiles-')))
  roots.push(root)
  const commonDirectory = path.join(root, 'repo', '.git')
  const otherCommonDirectory = path.join(root, 'other', '.git')
  const liveWorktree = path.join(root, 'live')
  mkdirSync(commonDirectory, { recursive: true })
  mkdirSync(otherCommonDirectory, { recursive: true })
  mkdirSync(liveWorktree)
  const profilesRoot = path.join(root, 'orca-dev-wt')
  const profile = (name, repoRoot, gitCommonDir) => {
    const dir = path.join(profilesRoot, name)
    writeWorktreeProfileMarker(dir, { repoRoot, instanceKey: repoRoot, gitCommonDir })
    return dir
  }
  const removed = profile('aaaaaaaaaa', path.join(root, 'removed'), commonDirectory)
  const live = profile('bbbbbbbbbb', liveWorktree, commonDirectory)
  const otherRepo = profile('cccccccccc', path.join(root, 'gone-other'), otherCommonDirectory)
  const running = profile('dddddddddd', path.join(root, 'removed-running'), commonDirectory)
  writeFileSync(path.join(running, 'orca-runtime.json'), JSON.stringify({ pid: 4242 }))

  const result = await reclaimDevWorktreeProfiles({
    apply: true,
    profilesRoot,
    repository: { commonDirectory, worktrees: [liveWorktree] },
    isAlive: (pid) => pid === 4242,
    report: () => {}
  })

  expect(result).toEqual({ entries: 1, protected: 1 })
  expect(existsSync(removed)).toBe(false)
  expect(existsSync(live)).toBe(true)
  expect(existsSync(otherRepo)).toBe(true)
  expect(existsSync(running)).toBe(true)
})
