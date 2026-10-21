import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as CheckoutGitConfig from '../wsl-windows-checkout-git-config'
import type * as GitRunner from '../runner'
import type * as WatcherObservers from '../../ipc/local-watcher-event-observers'
import type { GitStatusEntry } from '../../../shared/git-status-types'
import { notifyLocalWatcherEvents } from '../../ipc/local-watcher-event-observers'
import type { WatchedRoot } from '../../ipc/filesystem-watcher-wsl'
import { createDebouncedBatch } from '../../ipc/filesystem-watcher-batch-control'

type StreamMock = (
  args: string[],
  options: { onStdout: (chunk: string) => void }
) => Promise<{ stoppedEarly: boolean }>

const mocks = vi.hoisted(() => {
  const state: {
    appliesTo: Set<string>
    coveringRoot: WatchedRoot | null
    gitStreamStdout: ReturnType<typeof vi.fn<StreamMock>>
  } = { appliesTo: new Set(), coveringRoot: null, gitStreamStdout: vi.fn<StreamMock>() }
  return state
})

vi.mock('../wsl-windows-checkout-git-config', async (importOriginal) => {
  const actual = await importOriginal<typeof CheckoutGitConfig>()
  return {
    ...actual,
    withWslWindowsCheckoutGitConfig: (args: string[], cwd: string | undefined) =>
      cwd && mocks.appliesTo.has(cwd) ? ['-c', 'core.checkStat=minimal', ...args] : args
  }
})

vi.mock('../../ipc/local-watcher-event-observers', async (importOriginal) => {
  const actual = await importOriginal<typeof WatcherObservers>()
  return { ...actual, findCoveringLocalWatchRoot: () => mocks.coveringRoot }
})

vi.mock('../runner', async (importOriginal) => {
  const actual = await importOriginal<typeof GitRunner>()
  return { ...actual, gitStreamStdout: mocks.gitStreamStdout }
})

const {
  driveCheckoutSuspectTrackerForTests,
  mergeSuspectStatus,
  reconcileDriveCheckoutSuspects,
  resetDriveCheckoutSuspectsForTests
} = await import('./drive-checkout-suspect-status')

function watchRoot(rootPath: string): WatchedRoot {
  return {
    subscription: { unsubscribe: async () => {} },
    listeners: new Map(),
    batch: createDebouncedBatch(),
    rootPath
  }
}

const unstaged = (filePath: string, extra: Partial<GitStatusEntry> = {}): GitStatusEntry => ({
  path: filePath,
  status: 'modified',
  area: 'unstaged',
  ...extra
})

describe('mergeSuspectStatus', () => {
  it('overrides unstaged rows only for checked paths and keeps staged and untracked rows', () => {
    const minimal: GitStatusEntry[] = [
      { path: 'a.ts', status: 'modified', area: 'staged' },
      unstaged('b.ts'),
      unstaged('keep.ts'),
      { path: 'new.ts', status: 'untracked', area: 'untracked' }
    ]
    const merged = mergeSuspectStatus(minimal, new Set(['a.ts', 'b.ts', 'c.ts']), [
      unstaged('a.ts'),
      unstaged('c.ts'),
      unstaged('keep.ts')
    ])
    expect(merged).toEqual([
      { path: 'a.ts', status: 'modified', area: 'staged' },
      unstaged('a.ts'),
      unstaged('keep.ts'),
      unstaged('c.ts'),
      { path: 'new.ts', status: 'untracked', area: 'untracked' }
    ])
  })

  it('carries a staged rename source onto the rechecked unstaged row', () => {
    const minimal: GitStatusEntry[] = [
      { path: 'new.ts', status: 'renamed', area: 'staged', oldPath: 'old.ts' }
    ]
    expect(mergeSuspectStatus(minimal, new Set(['new.ts']), [unstaged('new.ts')])).toEqual([
      minimal[0],
      unstaged('new.ts', { oldPath: 'old.ts' })
    ])
  })
})

describe('reconcileDriveCheckoutSuspects', () => {
  let repo: string
  let root: WatchedRoot

  beforeEach(async () => {
    repo = await mkdtemp(path.join(tmpdir(), 'orca-suspects-'))
    root = watchRoot(repo)
    mocks.appliesTo = new Set([repo])
    mocks.coveringRoot = root
    mocks.gitStreamStdout.mockReset()
  })

  afterEach(async () => {
    resetDriveCheckoutSuspectsForTests()
    await rm(repo, { recursive: true, force: true })
  })

  async function touchFiles(names: string[]): Promise<void> {
    for (const name of names) {
      await mkdir(path.dirname(path.join(repo, name)), { recursive: true })
      await writeFile(path.join(repo, name), 'x')
    }
  }

  function changed(names: string[]): void {
    notifyLocalWatcherEvents(
      root,
      names.map((name) => ({ type: 'update', path: path.join(repo, name) }))
    )
  }

  function answer(dirty: Set<string>): void {
    mocks.gitStreamStdout.mockImplementation(async (args, options) => {
      for (const arg of args) {
        const target = arg.startsWith(':(literal)') ? arg.slice(':(literal)'.length) : null
        if (target && dirty.has(target)) {
          options.onStdout(`1 .M N... 100644 100644 100644 aaa aaa ${target}\n`)
        }
      }
      return { stoppedEarly: false }
    })
  }

  it('does nothing for checkouts outside the Windows-checkout config', async () => {
    mocks.appliesTo = new Set()
    await reconcileDriveCheckoutSuspects(repo, [], {})
    changed(['a.ts'])
    expect(await reconcileDriveCheckoutSuspects(repo, [], {})).toEqual([])
    expect(mocks.gitStreamStdout).not.toHaveBeenCalled()
  })

  it('rechecks only suspects minimal status reported clean, keeping the dirty ones', async () => {
    await touchFiles(['clean.ts', 'hidden edit.ts', 'already.ts'])
    await reconcileDriveCheckoutSuspects(repo, [], {})
    changed(['clean.ts', 'hidden edit.ts', 'already.ts', '.git/index'])
    answer(new Set(['hidden edit.ts']))

    const entries = await reconcileDriveCheckoutSuspects(repo, [unstaged('already.ts')], {})

    expect(entries).toEqual([unstaged('already.ts'), unstaged('hidden edit.ts')])
    const [args] = mocks.gitStreamStdout.mock.calls[0]
    expect(args).toContain('core.checkStat=default')
    expect(args.filter((arg) => arg.startsWith(':(literal)'))).toEqual([
      ':(literal)clean.ts',
      ':(literal)hidden edit.ts'
    ])
    const snapshot = driveCheckoutSuspectTrackerForTests(repo)?.beginPoll(root)
    expect([...(snapshot?.keys() ?? [])]).toEqual(['hidden edit.ts'])
  })

  it('skips directories and vanished paths without spawning git', async () => {
    await mkdir(path.join(repo, 'dir'))
    await reconcileDriveCheckoutSuspects(repo, [], {})
    changed(['dir', 'gone.ts'])
    expect(await reconcileDriveCheckoutSuspects(repo, [], {})).toEqual([])
    expect(mocks.gitStreamStdout).not.toHaveBeenCalled()
    expect(driveCheckoutSuspectTrackerForTests(repo)?.size).toBe(0)
  })

  it('batches a large suspect set across several pathspec-limited commands', async () => {
    const names = Array.from({ length: 250 }, (_, index) => `src/f${index}.ts`)
    await touchFiles(names)
    await reconcileDriveCheckoutSuspects(repo, [], {})
    changed(names)
    answer(new Set(['src/f7.ts', 'src/f249.ts']))

    const entries = await reconcileDriveCheckoutSuspects(repo, [], {})

    expect(mocks.gitStreamStdout.mock.calls.length).toBeGreaterThan(1)
    const pathspecs = mocks.gitStreamStdout.mock.calls.flatMap(([args]) =>
      args.filter((arg) => arg.startsWith(':(literal)'))
    )
    expect(pathspecs).toHaveLength(250)
    expect(entries.map((entry) => entry.path).sort()).toEqual(['src/f249.ts', 'src/f7.ts'])
  })

  it('keeps suspects when the recheck fails', async () => {
    await touchFiles(['a.ts'])
    await reconcileDriveCheckoutSuspects(repo, [], {})
    changed(['a.ts'])
    mocks.gitStreamStdout.mockRejectedValue(new Error('spawn failed'))
    expect(await reconcileDriveCheckoutSuspects(repo, [], {})).toEqual([])
    expect(driveCheckoutSuspectTrackerForTests(repo)?.size).toBe(1)
  })

  it('stays minimal-only when no watcher covers the checkout', async () => {
    await touchFiles(['a.ts'])
    await reconcileDriveCheckoutSuspects(repo, [], {})
    changed(['a.ts'])
    mocks.coveringRoot = null
    expect(await reconcileDriveCheckoutSuspects(repo, [], {})).toEqual([])
    expect(mocks.gitStreamStdout).not.toHaveBeenCalled()
    expect(driveCheckoutSuspectTrackerForTests(repo)?.lastDegradeReason).toBe('no-watcher')
  })
})
