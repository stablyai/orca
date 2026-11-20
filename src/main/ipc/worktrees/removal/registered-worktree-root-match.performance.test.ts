import { AsyncLocalStorage, createHook } from 'node:async_hooks'
import { resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type * as Containment from '../../../filesystem/local-file-io/filesystem-path-containment'
import { findRegisteredWorktreeRootAsync } from './registered-worktree-root-match'
import type { Repo } from '../../../../shared/repository/repo-types'
import {
  isRegisteredWorktreePathAsync,
  registerWorktreeRootsForRepo
} from './registered-worktree-roots-cache'

const probe = vi.hoisted(
  (): { read: null | ((target: string, root: string) => boolean | Promise<boolean>) } => ({
    read: null
  })
)
vi.mock('../../../filesystem/local-file-io/filesystem-path-containment', async (importOriginal) => {
  const actual = await importOriginal<typeof Containment>()
  return {
    ...actual,
    isDescendantOrEqualAsync: (target: string, root: string) =>
      probe.read ? probe.read(target, root) : actual.isDescendantOrEqualAsync(target, root)
  }
})
afterEach(() => {
  probe.read = null
})

it.each([12, 120])('synchronizes %i owners once for a successful ASCII lookup', async (count) => {
  const repos: Repo[] = Array.from({ length: count }, (_, index) => ({
    id: `repo-${index}`,
    path: `/repos/${index}`,
    displayName: 'repo',
    badgeColor: '#000',
    addedAt: 0
  }))
  const getRepos = vi.fn(() => repos)
  const store = { getRepos }
  const roots = Array.from(
    { length: count === 12 ? 750 : 7500 },
    (_, index) => `/worktrees/root-${index}`
  )
  registerWorktreeRootsForRepo(store, repos[0], roots)
  getRepos.mockClear()
  await expect(
    isRegisteredWorktreePathAsync(resolve('/worktrees/root-7/shot.png'), store)
  ).resolves.toBe(true)
  expect(getRepos).toHaveBeenCalledTimes(1)
})

it.each([true, false])(
  'revalidates owner removal after an awaited Unicode result %s',
  async (matched) => {
    const repo: Repo = {
      id: 'unicode',
      path: '/repos/unicode',
      displayName: 'repo',
      badgeColor: '#000',
      addedAt: 0
    }
    let repos = [repo]
    const getRepos = vi.fn(() => repos)
    const store = { getRepos }
    registerWorktreeRootsForRepo(store, repo, ['/worktrees/café', '/worktrees/café'])
    getRepos.mockClear()
    let release = (_matched: boolean) => {}
    probe.read = (_target, root) =>
      root === resolve('/worktrees/café')
        ? true
        : new Promise<boolean>((resolve) => {
            release = resolve
          })
    const pending = isRegisteredWorktreePathAsync(resolve('/worktrees/café/shot.png'), store)
    repos = []
    release(matched)
    await expect(pending).resolves.toBe(false)
    expect(getRepos).toHaveBeenCalledTimes(2)
  }
)

it.each([750, 7500])(
  'keeps ASCII containment synchronous across %i registered roots',
  async (count) => {
    const scope = new AsyncLocalStorage<boolean>()
    let promises = 0
    const hook = createHook({
      init: (_id, type) => {
        if (type === 'PROMISE' && scope.getStore()) {
          promises++
        }
      }
    })
    const roots = Array.from({ length: count }, (_, index) => `/worktrees/root-${index}`)
    hook.enable()
    try {
      const result = await scope.run(true, () =>
        findRegisteredWorktreeRootAsync('/outside/shot.png', roots)
      )
      expect(result).toBeNull()
    } finally {
      hook.disable()
    }
    expect(promises).toBe(1)
    await expect(
      findRegisteredWorktreeRootAsync('/worktrees/root-7/shot.png', roots)
    ).resolves.toBe('/worktrees/root-7')
  }
)

it.each([1, 10])(
  'pins remaining roots before a Unicode probe can refresh the live set %i times',
  async (refreshes) => {
    const roots = new Set(['/worktrees/café', '/worktrees/café'])
    let reads = 0
    probe.read = (_target, root) => {
      if (root === '/worktrees/café') {
        return true
      }
      reads++
      return new Promise<boolean>((resolve) =>
        queueMicrotask(() => {
          if (reads <= refreshes) {
            roots.clear()
            roots.add('/worktrees/café')
            roots.add('/worktrees/café')
          }
          resolve(false)
        })
      )
    }
    await expect(findRegisteredWorktreeRootAsync('/worktrees/café/shot.png', roots)).resolves.toBe(
      '/worktrees/café'
    )
    expect(reads).toBe(1)
  }
)
