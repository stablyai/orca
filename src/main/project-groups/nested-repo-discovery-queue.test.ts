import { posix, win32 } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { scanNestedRepos } from './nested-repo-discovery'

const branchNames = Array.from(
  { length: 160 },
  (_, index) => `branch-${String(index).padStart(3, '0')}`
)
afterEach(() => vi.restoreAllMocks())

function fixture(paths: typeof posix, onRead: (count: number) => void = () => {}) {
  const root = paths.resolve('/workspace')
  const visits: string[] = []
  const branches = branchNames.map((name) => paths.join(root, name))
  const descendants = branches.map((path) => paths.join(path, 'deeper'))
  const repositories = descendants.map((path) => paths.join(path, 'repository'))
  return {
    root,
    visits,
    branches,
    descendants,
    repositories,
    filesystem: {
      readDirectory: async (path: string) => {
        visits.push(path)
        onRead(visits.length)
        const names =
          path === root
            ? branchNames.toReversed()
            : paths.basename(path) === 'deeper'
              ? ['repository']
              : ['ignored', 'deeper', '.gitignore']
        return names.map((name) => ({ name, isDirectory: name !== '.gitignore' }))
      },
      readTextFile: async () => 'ignored/',
      joinPath: paths.join,
      basename: paths.basename,
      hasGitMarker: (path: string) => paths.basename(path) === 'repository',
      isSelectedPathGitRepo: () => false
    }
  }
}

it.each([
  ['local Windows paths', win32],
  ['SSH POSIX paths', posix]
] as const)('preserves broad BFS order and inherited ignores with %s', async (_label, paths) => {
  const f = fixture(paths)
  const result = await scanNestedRepos({
    path: f.root,
    options: { maxRepos: 500 },
    filesystem: f.filesystem
  })
  expect(f.visits).toEqual([f.root, ...f.branches, ...f.descendants])
  expect(result.repos.map(({ path }) => path)).toEqual(f.repositories)
  expect(result.repos.every(({ depth }) => depth === 3)).toBe(true)
  expect(result).toMatchObject({
    truncated: false,
    stopped: false,
    timedOut: false,
    timeoutMs: null
  })
})

it('preserves max depth and result caps during broad traversal', async () => {
  const depth = fixture(posix)
  const boundedDepth = await scanNestedRepos({
    path: depth.root,
    options: { maxDepth: 1 },
    filesystem: depth.filesystem
  })
  expect(depth.visits).toEqual([depth.root, ...depth.branches])
  expect(boundedDepth.repos).toEqual([])
  const capped = fixture(posix)
  const boundedResults = await scanNestedRepos({
    path: capped.root,
    options: { maxRepos: 7 },
    filesystem: capped.filesystem
  })
  expect(boundedResults.repos.map(({ path }) => path)).toEqual(capped.repositories.slice(0, 7))
  expect(boundedResults.truncated).toBe(true)
})

it('honors abort after a broad prefix has been consumed', async () => {
  const controller = new AbortController()
  const f = fixture(posix, (count) => {
    if (count === 200) {
      controller.abort()
    }
  })
  const result = await scanNestedRepos({
    path: f.root,
    signal: controller.signal,
    options: { maxRepos: 500 },
    filesystem: f.filesystem
  })
  expect(f.visits).toHaveLength(200)
  expect(result.repos.map(({ path }) => path)).toEqual(f.repositories.slice(0, 38))
  expect(result).toMatchObject({ stopped: true, timedOut: false })
})

it.each([null, 500])(
  'preserves optional timeout=%s after consuming a broad prefix',
  async (timeoutMs) => {
    let now = 0
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const f = fixture(posix, (count) => {
      if (count === 200) {
        now = 1_000
      }
    })
    const result = await scanNestedRepos({
      path: f.root,
      options: { maxRepos: 500, timeoutMs },
      filesystem: f.filesystem
    })
    expect(result.repos.map(({ path }) => path)).toEqual(
      timeoutMs === null ? f.repositories : f.repositories.slice(0, 38)
    )
    expect(result).toMatchObject({ timedOut: timeoutMs !== null, timeoutMs, stopped: false })
  }
)
