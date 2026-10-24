import { mkdir, mkdtemp, readFile, rename, rm, utimes, writeFile } from 'node:fs/promises'
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
  const state: { minimalRepos: Set<string>; execArgs: string[][] } = {
    minimalRepos: new Set(),
    execArgs: []
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
    gitExecFileAsync: (...params: Parameters<typeof actual.gitExecFileAsync>) => {
      mocks.execArgs.push(params[0])
      return actual.gitExecFileAsync(...params)
    }
  }
})

const { getStatus } = await import('./status-read')
const { resetDriveCheckoutSuspectsForTests } = await import('./drive-checkout-suspect-status')
const { invalidateGitReadCaches } = await import('./git-read-cache-invalidation')
const { bulkStageFiles, stageFile, stageWorktreeChanges } = await import('./staging')
const { bulkDiscardChanges, discardChanges } = await import('./discard-changes')

const OLD = new Date('2020-01-01T00:00:00Z')

describe('drive checkout suspect writes with real Git', () => {
  let repo: string
  let root: WatchedRoot
  let rootKey: string

  async function git(args: string[]): Promise<string> {
    const result = await runProcess({ program: 'git', args, cwd: repo })
    expect(result.code, result.stderr).toBe(0)
    return result.stdout
  }

  async function writeOld(name: string, content: string): Promise<void> {
    await writeFile(path.join(repo, name), content)
    await utimes(path.join(repo, name), OLD, OLD)
  }

  beforeEach(async () => {
    repo = await mkdtemp(path.join(tmpdir(), 'orca-suspect-write-'))
    await git(['init', '-q'])
    await git(['config', 'user.email', 'test@example.com'])
    await git(['config', 'user.name', 'Test User'])
    await mkdir(path.join(repo, 'sub'))
    for (const name of ['a.txt', 'c d.txt', 'sub/e.txt']) {
      await writeOld(name, 'aaaa\n')
    }
    await git(['add', '.'])
    await git(['commit', '-q', '-m', 'initial'])
    mocks.minimalRepos = new Set([repo])
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

  async function statusPaths(): Promise<string[]> {
    const result = await getStatus(repo, { includeLineStats: false })
    return result.entries.map((entry) => `${entry.area}:${entry.path}`)
  }

  /** A same-size rewrite that kept its mtime, reported by the watcher and shown by status. */
  async function rewriteSuspect(name: string, content: string): Promise<void> {
    expect(await statusPaths()).toEqual([])
    const staging = path.join(repo, `${name}.tmp`)
    await writeFile(staging, content)
    await utimes(staging, OLD, OLD)
    await rename(staging, path.join(repo, name))
    notifyLocalWatcherEvents(root, [{ type: 'update', path: path.join(repo, name) }])
    expect(await statusPaths()).toEqual([`unstaged:${name}`])
    mocks.execArgs = []
  }

  async function stagedPaths(): Promise<string[]> {
    return (await git(['diff', '--cached', '--name-only', '-z'])).split('\0').filter(Boolean)
  }

  function defaultStatWrites(): string[][] {
    return mocks.execArgs.filter((args) => args.includes('core.checkStat=default'))
  }

  it('stages a suspect that minimal-stat add treats as unchanged', async () => {
    await rewriteSuspect('c d.txt', 'bbbb\n')
    // Demonstrate that minimal-stat add misses the rewrite.
    await git(['-c', 'core.checkStat=minimal', 'add', '--', 'c d.txt'])
    expect(await stagedPaths()).toEqual([])

    await stageFile(repo, 'c d.txt')

    expect(await stagedPaths()).toEqual(['c d.txt'])
    expect(defaultStatWrites()).toEqual([
      ['-c', 'core.checkStat=default', 'add', '--update', '--', ':(literal)c d.txt']
    ])
    expect(await statusPaths()).toEqual(['staged:c d.txt'])
  })

  it('redoes only the suspects of a bulk or folder stage, by argv', async () => {
    await rewriteSuspect('sub/e.txt', 'bbbb\n')
    await writeFile(path.join(repo, 'a.txt'), 'longer content\n')

    await bulkStageFiles(repo, ['a.txt', 'sub'])

    expect(await stagedPaths()).toEqual(['a.txt', 'sub/e.txt'])
    const redo = defaultStatWrites()
    expect(redo).toEqual([
      ['-c', 'core.checkStat=default', 'add', '--update', '--', ':(literal)sub/e.txt']
    ])
    // Why: `add`/`restore` only gained --pathspec-from-file in Git 2.26.
    expect(redo.flat()).not.toContain('--pathspec-from-file=-')
    // The main write keeps its pathspec-from-file shape and the injected minimal stat.
    expect(mocks.execArgs).toContainEqual(['add', '--pathspec-from-file=-', '--pathspec-file-nul'])
  })

  it('keeps writes outside the suspect set on minimal stat alone', async () => {
    await rewriteSuspect('c d.txt', 'bbbb\n')
    await writeFile(path.join(repo, 'a.txt'), 'longer content\n')

    await stageFile(repo, 'a.txt')
    await bulkStageFiles(repo, ['a.txt', 'sub'])

    expect(await stagedPaths()).toEqual(['a.txt'])
    expect(defaultStatWrites()).toEqual([])
  })

  it('stages a suspect through a scoped stage-all', async () => {
    await rewriteSuspect('c d.txt', 'bbbb\n')

    await stageWorktreeChanges(repo, 'tracked')

    expect(await stagedPaths()).toEqual(['c d.txt'])
    expect(defaultStatWrites()).toHaveLength(1)
  })

  it('discards a suspect that minimal-stat restore treats as unchanged', async () => {
    await rewriteSuspect('c d.txt', 'bbbb\n')

    await discardChanges(repo, 'c d.txt')

    // Why CRLF: the injected autocrlf=true checks out like Windows Git.
    expect(await readFile(path.join(repo, 'c d.txt'), 'utf8')).toBe('aaaa\r\n')
    expect(await statusPaths()).toEqual([])
  })

  it('discards a suspect inside a bulk folder discard', async () => {
    await rewriteSuspect('sub/e.txt', 'bbbb\n')

    await bulkDiscardChanges(repo, ['sub'])

    expect(await readFile(path.join(repo, 'sub/e.txt'), 'utf8')).toBe('aaaa\r\n')
    expect(defaultStatWrites()).toEqual([
      ['-c', 'core.checkStat=default', 'restore', '--worktree', '--', ':(literal)sub/e.txt']
    ])
  })

  it('leaves an untracked suspect to the main write', async () => {
    expect(await statusPaths()).toEqual([])
    await writeOld('new.txt', 'nnnn\n')
    notifyLocalWatcherEvents(root, [{ type: 'create', path: path.join(repo, 'new.txt') }])
    expect(await statusPaths()).toEqual(['untracked:new.txt'])
    mocks.execArgs = []

    await stageFile(repo, 'new.txt')

    expect(await stagedPaths()).toEqual(['new.txt'])
    expect(defaultStatWrites()).toEqual([])
  })
})
