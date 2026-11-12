import { win32 } from 'node:path'
import type * as NodePath from 'node:path'
import { describe, expect, it, vi } from 'vitest'

// Exercise production UNC resolution on every CI host; keep matching and elections real.
vi.mock('node:path', async (importOriginal) => {
  const actual = await importOriginal<typeof NodePath>()
  return { ...actual, resolve: actual.win32.resolve }
})

import {
  selectEnclosingRepoOnHost,
  selectEnclosingWorktreeSelectionOnHost
} from '../workspace-selection/caller-host-worktree-selection'
import { buildWorktree } from '../test-fixtures'
import { toSshExecutionHostId } from '../../shared/execution-host'

const UPPER = String.raw`\\wsl.localhost\Ubuntu\home\Alice\App`
const LOWER = String.raw`\\wsl$\Ubuntu\home\alice\app`
const upper = buildWorktree(UPPER, 'main', 'abc', 'repo-a')
const lower = buildWorktree(LOWER, 'main', 'abc', 'repo-b')

describe('WSL enclosing selection with Windows path resolution on every platform', () => {
  it('excludes case-distinct directories before caller preference in either order', () => {
    for (const rows of [
      [upper, lower],
      [lower, upper]
    ]) {
      for (const owner of [upper, lower]) {
        for (const caller of [undefined, upper.id, lower.id]) {
          const cwd = win32.join(owner.path, 'src')
          expect(selectEnclosingWorktreeSelectionOnHost(rows, cwd, 'local', caller)).toEqual({
            selector: `id:${owner.id}`,
            worktreeId: owner.id
          })
          expect(selectEnclosingRepoOnHost(rows, cwd, 'local', caller)).toBe(owner.repoId)
        }
      }
    }
    const wrongDistro = { ...upper, path: UPPER.replace('Ubuntu', 'Debian') }
    const wrongHost = { ...upper, hostId: toSshExecutionHostId('other') }
    expect(
      selectEnclosingWorktreeSelectionOnHost([wrongDistro, wrongHost], UPPER, 'local')
    ).toBeUndefined()
    expect(selectEnclosingRepoOnHost([wrongDistro, wrongHost], UPPER, 'local')).toBeUndefined()
  })
})
