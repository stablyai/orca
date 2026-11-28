import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { runProcessSync, spawnProcess } from '@orca/process-host'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitStatusEntry } from '../../../../shared/git/status/git-status-types'
import type * as GitExecFileModule from '../../command-runner/git-exec-file'
import { getStatus } from './status-read'
import { attachLineStats } from './status-line-stats'
import {
  INCOMPLETE_NUMSTAT_FALLBACK_TTL_MS,
  invalidateGitReadCaches
} from '../git-read-cache-invalidation'

const gitFailures = vi.hoisted(
  (): {
    wholeNumstat: boolean
    pathspec: string | null
    wholeNumstatCalls: number
    pathspecCalls: number
    blockPathspec: string | null
    deferredStarted: (() => void) | null
    releaseDeferred: (() => void) | null
  } => ({
    wholeNumstat: false,
    pathspec: null,
    wholeNumstatCalls: 0,
    pathspecCalls: 0,
    blockPathspec: null,
    deferredStarted: null,
    releaseDeferred: null
  })
)

// Fail the whole-worktree pass on demand while per-path retries still reach real Git.
vi.mock('../../command-runner/git-exec-file', async (importOriginal) => {
  const actual = await importOriginal<typeof GitExecFileModule>()
  return {
    ...actual,
    gitExecFileAsync: (args: string[], options: Parameters<typeof actual.gitExecFileAsync>[1]) => {
      if (args.includes('--numstat')) {
        const pathspecStart = args.indexOf('--')
        if (gitFailures.wholeNumstat && pathspecStart === -1) {
          gitFailures.wholeNumstatCalls++
          return Promise.reject(new Error('error: cannot hash locked.txt'))
        }
        if (
          pathspecStart !== -1 &&
          gitFailures.blockPathspec !== null &&
          args.includes(gitFailures.blockPathspec)
        ) {
          gitFailures.pathspecCalls++
          return new Promise((_resolve, reject) => {
            gitFailures.releaseDeferred = () => reject(new Error('error: cannot hash locked.txt'))
            gitFailures.deferredStarted?.()
          })
        }
        if (
          pathspecStart !== -1 &&
          gitFailures.pathspec !== null &&
          args.includes(gitFailures.pathspec)
        ) {
          gitFailures.pathspecCalls++
          return Promise.reject(new Error('error: cannot hash locked.txt'))
        }
      }
      return actual.gitExecFileAsync(args, options)
    }
  }
})

let root: string
let repo: string

function git(args: string[], cwd = repo): string {
  const result = runProcessSync({ program: 'git', args, cwd })
  expect(result.code, result.stderr).toBe(0)
  return result.stdout.trim()
}

function gitExitCode(args: string[]): number | null {
  return runProcessSync({ program: 'git', args, cwd: repo }).code
}

async function commitBaseline(files: Record<string, string>): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(repo, name), content)
  }
  git(['add', '-A'])
  git(['commit', '-qm', 'baseline'])
}

// Matches the Windows repro: an exclusive share-mode lock makes Git's content read fail.
async function holdExclusiveLock(file: string): Promise<() => Promise<void>> {
  const holder = spawnProcess({
    program: 'powershell.exe',
    args: [
      '-NoProfile',
      '-Command',
      "$f = [IO.File]::Open($env:LOCK, 'Open', 'ReadWrite', 'None'); [Console]::Out.WriteLine('locked'); [void][Console]::In.ReadLine(); $f.Dispose()"
    ],
    env: { ...process.env, LOCK: file },
    stdio: 'pipe'
  })
  const closed = new Promise((resolve) => holder.once('close', resolve))
  await createInterface({ input: holder.stdout })[Symbol.asyncIterator]().next()
  return async () => {
    holder.stdin.end()
    await closed
  }
}

beforeEach(async () => {
  invalidateGitReadCaches()
  gitFailures.wholeNumstat = false
  gitFailures.pathspec = null
  gitFailures.wholeNumstatCalls = 0
  gitFailures.pathspecCalls = 0
  gitFailures.blockPathspec = null
  gitFailures.deferredStarted = null
  gitFailures.releaseDeferred = null
  vi.stubEnv('ORCA_GIT_STATUS_NUMSTAT_REUSE', '0')
  root = await mkdtemp(join(tmpdir(), 'orca-status-locked-'))
  repo = join(root, 'repo')
  const emptyConfig = join(root, 'empty-git-config')
  await writeFile(emptyConfig, '')
  vi.stubEnv('GIT_CONFIG_GLOBAL', emptyConfig)
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
  git(['init', '-q', repo], root)
  git(['config', 'user.name', 'Test'])
  git(['config', 'user.email', 'test@example.invalid'])
})

afterEach(async () => {
  invalidateGitReadCaches()
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})

describe('per-path numstat fallback', () => {
  it('keeps readable and rename counts when the whole-worktree pass fails', async () => {
    await commitBaseline({
      'readable.txt': 'one\ntwo\nthree\n',
      'locked.txt': 'red\ngreen\nblue\n',
      'renamed-old.txt': 'alpha\nbeta\n'
    })
    await writeFile(join(repo, 'readable.txt'), 'one\ntwo\nthree\nfour\nfive\n')
    await writeFile(join(repo, 'locked.txt'), 'red\ngreen\nblue\nyellow\n')
    await rename(join(repo, 'renamed-old.txt'), join(repo, 'renamed-new.txt'))
    await writeFile(join(repo, 'renamed-new.txt'), 'alpha\nbeta\ngamma\n')
    // git diff only pairs a rename with intent-to-add; an untracked file never appears.
    git(['add', '-N', 'renamed-new.txt'])
    gitFailures.wholeNumstat = true
    const entries: GitStatusEntry[] = [
      { path: 'readable.txt', status: 'modified', area: 'unstaged' },
      { path: 'locked.txt', status: 'modified', area: 'unstaged' },
      {
        path: 'renamed-new.txt',
        oldPath: 'renamed-old.txt',
        status: 'renamed',
        area: 'unstaged'
      }
    ]

    expect(await attachLineStats(repo, entries)).toBe(true)

    expect(entries).toEqual([
      { path: 'readable.txt', status: 'modified', area: 'unstaged', added: 2, removed: 0 },
      { path: 'locked.txt', status: 'modified', area: 'unstaged', added: 1, removed: 0 },
      {
        path: 'renamed-new.txt',
        oldPath: 'renamed-old.txt',
        status: 'renamed',
        area: 'unstaged',
        added: 1,
        removed: 0
      }
    ])
  })

  it('leaves a still-failing row uncounted and does not report the pass as complete', async () => {
    await commitBaseline({
      'readable.txt': 'one\ntwo\nthree\n',
      'locked.txt': 'red\ngreen\nblue\n'
    })
    await writeFile(join(repo, 'readable.txt'), 'one\ntwo\nthree\nfour\nfive\n')
    await writeFile(join(repo, 'locked.txt'), 'red\ngreen\nblue\nyellow\n')
    gitFailures.wholeNumstat = true
    gitFailures.pathspec = ':(literal)locked.txt'
    const entries: GitStatusEntry[] = [
      { path: 'readable.txt', status: 'modified', area: 'unstaged' },
      { path: 'locked.txt', status: 'modified', area: 'unstaged' }
    ]

    expect(await attachLineStats(repo, entries)).toBe(false)

    expect(entries).toEqual([
      { path: 'readable.txt', status: 'modified', area: 'unstaged', added: 2, removed: 0 },
      { path: 'locked.txt', status: 'modified', area: 'unstaged' }
    ])
  })

  it('backs off an incomplete fallback for 5 seconds, then retries', async () => {
    await commitBaseline({
      'locked.txt': 'red\ngreen\nblue\n'
    })
    await writeFile(join(repo, 'locked.txt'), 'red\ngreen\nblue\nyellow\n')
    gitFailures.wholeNumstat = true
    gitFailures.pathspec = ':(literal)locked.txt'
    const entries: GitStatusEntry[] = [{ path: 'locked.txt', status: 'modified', area: 'unstaged' }]
    vi.setSystemTime(1_000_000)

    expect(await attachLineStats(repo, entries)).toBe(false)
    expect(gitFailures.wholeNumstatCalls).toBe(1)
    expect(gitFailures.pathspecCalls).toBe(1)

    expect(await attachLineStats(repo, entries)).toBe(false)
    expect(gitFailures.wholeNumstatCalls).toBe(1)
    expect(gitFailures.pathspecCalls).toBe(1)

    vi.setSystemTime(1_000_000 + INCOMPLETE_NUMSTAT_FALLBACK_TTL_MS + 1)
    expect(await attachLineStats(repo, entries)).toBe(false)
    expect(gitFailures.wholeNumstatCalls).toBe(2)
    expect(gitFailures.pathspecCalls).toBe(2)
  })

  it('does not repopulate the fallback when invalidation happens during a pending read', async () => {
    await commitBaseline({
      'readable.txt': 'one\ntwo\nthree\n',
      'locked.txt': 'red\ngreen\nblue\n'
    })
    await writeFile(join(repo, 'readable.txt'), 'one\ntwo\nthree\nfour\nfive\n')
    await writeFile(join(repo, 'locked.txt'), 'red\ngreen\nblue\nyellow\n')
    gitFailures.wholeNumstat = true
    gitFailures.pathspec = ':(literal)locked.txt'
    const entries: GitStatusEntry[] = [
      { path: 'readable.txt', status: 'modified', area: 'unstaged' },
      { path: 'locked.txt', status: 'modified', area: 'unstaged' }
    ]

    let markStarted!: () => void
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    gitFailures.deferredStarted = markStarted
    gitFailures.blockPathspec = gitFailures.pathspec

    const pending = attachLineStats(repo, entries)
    await started
    invalidateGitReadCaches()
    gitFailures.blockPathspec = null
    gitFailures.releaseDeferred?.()
    expect(await pending).toBe(false)

    expect(await attachLineStats(repo, entries)).toBe(false)
    expect(gitFailures.wholeNumstatCalls).toBe(2)
  })

  it('recounts readable files and new paths while only the failed path is backed off', async () => {
    await commitBaseline({
      'readable.txt': 'one\ntwo\nthree\n',
      'extra.txt': 'alpha\nbeta\n',
      'locked.txt': 'red\ngreen\nblue\n'
    })
    await writeFile(join(repo, 'readable.txt'), 'one\ntwo\nthree\nfour\nfive\n')
    await writeFile(join(repo, 'locked.txt'), 'red\ngreen\nblue\nyellow\n')
    gitFailures.wholeNumstat = true
    gitFailures.pathspec = ':(literal)locked.txt'
    vi.setSystemTime(2_000_000)
    const entries: GitStatusEntry[] = [
      { path: 'readable.txt', status: 'modified', area: 'unstaged' },
      { path: 'locked.txt', status: 'modified', area: 'unstaged' }
    ]

    expect(await attachLineStats(repo, entries)).toBe(false)
    expect(entries[0]).toMatchObject({ added: 2, removed: 0 })

    await writeFile(
      join(repo, 'readable.txt'),
      ['one', 'two', 'three', ...Array.from({ length: 10 }, (_, i) => `added${i}`), ''].join('\n')
    )
    await writeFile(join(repo, 'extra.txt'), 'alpha\nbeta\ngamma\n')
    entries.push({ path: 'extra.txt', status: 'modified', area: 'unstaged' })

    expect(await attachLineStats(repo, entries)).toBe(false)
    expect(gitFailures.wholeNumstatCalls).toBe(1)
    expect(entries).toEqual([
      { path: 'readable.txt', status: 'modified', area: 'unstaged', added: 10, removed: 0 },
      { path: 'locked.txt', status: 'modified', area: 'unstaged' },
      { path: 'extra.txt', status: 'modified', area: 'unstaged', added: 1, removed: 0 }
    ])
  })
})

it.runIf(process.platform === 'win32')(
  'keeps line counts for readable files while an exclusively locked file fails the pass',
  async () => {
    await commitBaseline({
      'readable.txt': 'one\ntwo\nthree\n',
      'locked.txt': 'red\ngreen\nblue\n'
    })
    await writeFile(join(repo, 'readable.txt'), 'one\ntwo\nthree\nfour\nfive\n')
    await writeFile(join(repo, 'locked.txt'), 'red\ngreen\nblue\nyellow\n')

    const release = await holdExclusiveLock(join(repo, 'locked.txt'))
    try {
      expect(gitExitCode(['diff', '--numstat'])).not.toBe(0)
      expect(gitExitCode(['diff', '--numstat', '--', 'readable.txt'])).toBe(0)

      invalidateGitReadCaches()
      const { entries } = await getStatus(repo)

      expect(entries).toEqual([
        { path: 'locked.txt', status: 'modified', area: 'unstaged' },
        { path: 'readable.txt', status: 'modified', area: 'unstaged', added: 2, removed: 0 }
      ])
    } finally {
      await release()
    }
  }
)
