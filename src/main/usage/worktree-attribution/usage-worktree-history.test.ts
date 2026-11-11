import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Repo } from '../../../shared/repo-types'
import { UsageWorktreeHistory } from './usage-worktree-history'
import { loadKnownUsageWorktreesByRepo, type UsageWorktreeSource } from './usage-worktree-metadata'

const repo: Repo = {
  id: 'repo-1',
  path: '/src/app',
  displayName: 'app',
  badgeColor: '#000000',
  addedAt: 0
}

function createStore(meta: Record<string, { displayName: string }>) {
  let listener: ((write: { worktreeId: string; next: { displayName: string } }) => void) | null =
    null
  return {
    getRepos: () => [repo],
    getAllWorktreeMeta: () => meta,
    onWorktreeMetaWritten: (next: NonNullable<typeof listener>) => {
      listener = next
      return () => {}
    },
    write(worktreeId: string, displayName: string) {
      meta[worktreeId] = { displayName }
      listener?.({ worktreeId, next: meta[worktreeId] })
    },
    remove(worktreeId: string) {
      delete meta[worktreeId]
    }
  }
}

function knownWorktrees(source: UsageWorktreeSource) {
  return loadKnownUsageWorktreesByRepo(source, [repo])
    .get('repo-1')
    ?.map(({ path, displayName }) => [path, displayName])
}

describe('UsageWorktreeHistory', () => {
  let dir: string | null = null
  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps removed worktrees attributed, across restarts', async () => {
    dir = mkdtempSync(join(tmpdir(), 'usage-worktree-history-'))
    const file = join(dir, 'history.json')
    const store = createStore({ 'repo-1::/ws/existing': { displayName: 'existing' } })
    const history = new UsageWorktreeHistory(store, file)
    store.write('repo-1::/ws/short-lived', 'short-lived')
    store.remove('repo-1::/ws/existing')
    store.remove('repo-1::/ws/short-lived')

    const expected = [
      ['/src/app', 'app'],
      ['/ws/existing', 'existing'],
      ['/ws/short-lived', 'short-lived']
    ]
    expect(knownWorktrees(history)).toEqual(expected)

    await history.flush()
    const restarted = new UsageWorktreeHistory(createStore({}), file)
    await restarted.whenLoaded()
    expect(knownWorktrees(restarted)).toEqual(expected)
  })

  it('leaves a history file from a newer build untouched', async () => {
    dir = mkdtempSync(join(tmpdir(), 'usage-worktree-history-'))
    const file = join(dir, 'history.json')
    const newer = '{"schemaVersion":2,"worktrees":[]}'
    writeFileSync(file, newer)
    const store = createStore({ 'repo-1::/ws/live': { displayName: 'live' } })
    const history = new UsageWorktreeHistory(store, file)
    store.write('repo-1::/ws/new', 'new')
    await history.flush()
    expect(readFileSync(file, 'utf8')).toBe(newer)
  })

  it('lets a live worktree in another repo own a path a removed one used', () => {
    const other: Repo = { ...repo, id: 'repo-2', path: '/src/other' }
    const source: UsageWorktreeSource = {
      getRepos: () => [repo, other],
      getAllWorktreeMeta: () => ({ 'repo-2::/ws/feat': { displayName: 'live' } }),
      getRememberedWorktreeDisplayNames: () => new Map([['repo-1::/ws/feat', 'removed']]),
      whenLoaded: async () => {}
    }
    const known = loadKnownUsageWorktreesByRepo(source, [repo, other])
    expect(known.get('repo-1')?.map(({ path }) => path)).toEqual(['/src/app'])
    expect(known.get('repo-2')?.map(({ path }) => path)).toEqual(['/src/other', '/ws/feat'])
  })
})
