import { mkdtemp, rename, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as CheckoutGitConfig from '../wsl-windows-checkout-git-config'
import type * as GitRunner from '../runner'
import { runProcess } from '@orca/process-host'
import { createDebouncedBatch } from '../../ipc/filesystem-watcher-batch-control'
import { watcherLifecycleState } from '../../ipc/filesystem-watcher-lifecycle-state'
import { getLocalWatcherRoot } from '../../ipc/filesystem-watcher-paths'
import type { WatchedRoot } from '../../ipc/filesystem-watcher-wsl'
import { notifyLocalWatcherEvents } from '../../ipc/local-watcher-event-observers'

const mocks = vi.hoisted(() => {
  const state: { minimalRepos: Set<string>; streamedArgs: string[][] } = {
    minimalRepos: new Set(),
    streamedArgs: []
  }
  return state
})

// Simulate a Windows Git drive checkout so calls use minimal stat.
vi.mock('../wsl-windows-checkout-git-config', async (importOriginal) => {
  const actual = await importOriginal<typeof CheckoutGitConfig>()
  return {
    ...actual,
    withWslWindowsCheckoutGitConfig: (args: string[], cwd: string | undefined) =>
      cwd && mocks.minimalRepos.has(cwd)
        ? [...actual.WINDOWS_CHECKOUT_GIT_CONFIG_ARGS, ...args]
        : args
  }
})

vi.mock('../runner', async (importOriginal) => {
  const actual = await importOriginal<typeof GitRunner>()
  return {
    ...actual,
    gitStreamStdout: (...params: Parameters<typeof actual.gitStreamStdout>) => {
      mocks.streamedArgs.push(params[0])
      return actual.gitStreamStdout(...params)
    }
  }
})

const { getStatus } = await import('./status-read')
const { resetDriveCheckoutSuspectsForTests } = await import('./drive-checkout-suspect-status')
const { invalidateGitReadCaches } = await import('./git-read-cache-invalidation')

const OLD = new Date('2020-01-01T00:00:00Z')

describe('drive checkout suspect paths with real Git', () => {
  let repo: string
  let root: WatchedRoot
  let rootKey: string

  async function git(args: string[]): Promise<void> {
    const result = await runProcess({ program: 'git', args, cwd: repo })
    expect(result.code, result.stderr).toBe(0)
  }

  beforeEach(async () => {
    repo = await mkdtemp(path.join(tmpdir(), 'orca-suspect-git-'))
    await git(['init', '-q'])
    await git(['config', 'user.email', 'test@example.com'])
    await git(['config', 'user.name', 'Test User'])
    for (const name of ['a.txt', 'b.txt', 'c d.txt']) {
      await writeFile(path.join(repo, name), 'aaaa\n')
      await utimes(path.join(repo, name), OLD, OLD)
    }
    await git(['add', '.'])
    await git(['commit', '-q', '-m', 'initial'])
    mocks.minimalRepos = new Set([repo])
    mocks.streamedArgs = []
    root = {
      subscription: { unsubscribe: async () => {} },
      listeners: new Map(),
      batch: createDebouncedBatch(),
      rootPath: repo
    }
    rootKey = getLocalWatcherRoot(repo).key
    watcherLifecycleState.watchedRoots.set(rootKey, root)
    invalidateGitReadCaches()
  })

  afterEach(async () => {
    watcherLifecycleState.watchedRoots.delete(rootKey)
    resetDriveCheckoutSuspectsForTests()
    invalidateGitReadCaches()
    await rm(repo, { recursive: true, force: true })
  })

  // Why replace via rename: a fresh inode is what default checkStat sees within the same ctime second.
  async function rewriteKeepingMtime(name: string, content: string): Promise<void> {
    const staging = path.join(repo, `${name}.tmp`)
    await writeFile(staging, content)
    await utimes(staging, OLD, OLD)
    await rename(staging, path.join(repo, name))
  }

  async function statusPaths(): Promise<string[]> {
    const result = await getStatus(repo, { includeLineStats: false })
    return result.entries.map((entry) => `${entry.area}:${entry.path}`)
  }

  it('catches a same-size rewrite that kept its mtime, rechecking only that path', async () => {
    expect(await statusPaths()).toEqual([])

    await rewriteKeepingMtime('c d.txt', 'bbbb\n')
    const beforeEvent = await statusPaths()
    expect(beforeEvent).toEqual([])

    notifyLocalWatcherEvents(root, [{ type: 'update', path: path.join(repo, 'c d.txt') }])
    mocks.streamedArgs = []
    expect(await statusPaths()).toEqual(['unstaged:c d.txt'])

    const targeted = mocks.streamedArgs.filter((args) => args.includes('core.checkStat=default'))
    expect(targeted).toHaveLength(1)
    expect(targeted[0].filter((arg) => arg.startsWith(':(literal)'))).toEqual([':(literal)c d.txt'])

    expect(await statusPaths()).toEqual(['unstaged:c d.txt'])

    await rewriteKeepingMtime('c d.txt', 'aaaa\n')
    expect(await statusPaths()).toEqual([])
    mocks.streamedArgs = []
    expect(await statusPaths()).toEqual([])
    expect(mocks.streamedArgs.some((args) => args.includes('core.checkStat=default'))).toBe(false)
  })
})
