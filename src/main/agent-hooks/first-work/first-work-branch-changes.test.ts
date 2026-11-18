import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { gitExecFileAsync } from '../../git/command-runner/git-exec-file'
import type { GitExecOptions } from '../../git/command-runner/git-exec-options'
import { readBranchChangesForNaming } from './first-work-branch-changes'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await gitExecFileAsync(args, { cwd, timeout: 20_000 })).stdout.trim()
}

/** A repo whose `main` holds one commit and whose HEAD is a fresh branch from it. */
async function repository(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'orca-branch-changes-'))
  roots.push(cwd)
  await git(cwd, 'init', '--quiet', '--initial-branch=main')
  await git(cwd, 'config', 'user.email', 'test@example.com')
  await git(cwd, 'config', 'user.name', 'Test')
  await git(cwd, 'config', 'commit.gpgsign', 'false')
  await writeFile(join(cwd, 'tracked.txt'), 'one\n')
  await git(cwd, 'add', 'tracked.txt')
  await git(cwd, 'commit', '--quiet', '-m', 'base')
  await git(cwd, 'switch', '--quiet', '-c', 'nautilus')
  return cwd
}

function read(
  cwd: string,
  baseRef: string | undefined = 'main',
  signal = new AbortController().signal
) {
  return readBranchChangesForNaming({ cwd, baseRef, signal, deadlineAt: Number.MAX_SAFE_INTEGER })
}

describe('readBranchChangesForNaming', () => {
  it('reports nothing-yet only for a genuinely empty branch', async () => {
    const cwd = await repository()
    await expect(read(cwd)).resolves.toEqual({ kind: 'nothing-yet' })
  })

  it('keeps a staged new file that was deleted from disk', async () => {
    const cwd = await repository()
    await writeFile(join(cwd, 'added.txt'), 'new\n')
    await git(cwd, 'add', 'added.txt')
    await unlink(join(cwd, 'added.txt'))
    const result = await read(cwd)
    expect(result.kind).toBe('changes')
    expect(result.kind === 'changes' && result.changes.stagedStat).toContain('added.txt')
  })

  it('keeps a staged edit that the working copy reversed', async () => {
    const cwd = await repository()
    await writeFile(join(cwd, 'tracked.txt'), 'two\n')
    await git(cwd, 'add', 'tracked.txt')
    await writeFile(join(cwd, 'tracked.txt'), 'one\n')
    const result = await read(cwd)
    expect(result.kind === 'changes' && result.changes.stagedStat).toContain('tracked.txt')
  })

  it('sees staged-only work when the base ref does not exist', async () => {
    const cwd = await repository()
    await writeFile(join(cwd, 'tracked.txt'), 'two\n')
    await git(cwd, 'add', 'tracked.txt')
    const result = await read(cwd, 'origin/missing')
    expect(result.kind === 'changes' && result.changes.stagedStat).toContain('tracked.txt')
  })

  it('names committed, unstaged and untracked work', async () => {
    const committed = await repository()
    await writeFile(join(committed, 'feature.txt'), 'x\n')
    await git(committed, 'add', 'feature.txt')
    await git(committed, 'commit', '--quiet', '-m', 'Add login form')
    const fromCommit = await read(committed)
    expect(fromCommit.kind === 'changes' && fromCommit.changes.commitSubjects).toBe(
      '- Add login form'
    )

    const unstaged = await repository()
    await writeFile(join(unstaged, 'tracked.txt'), 'two\n')
    const fromWorking = await read(unstaged)
    expect(fromWorking.kind === 'changes' && fromWorking.changes.workingStat).toContain(
      'tracked.txt'
    )

    const untracked = await repository()
    await writeFile(join(untracked, 'notes.md'), 'x\n')
    const fromUntracked = await read(untracked)
    expect(fromUntracked.kind === 'changes' && fromUntracked.changes.untracked).toBe('notes.md')
  })

  it('treats unrelated history as no base rather than a failure', async () => {
    const cwd = await repository()
    await git(cwd, 'switch', '--quiet', '--orphan', 'island')
    await git(cwd, 'commit', '--quiet', '--allow-empty', '-m', 'island root')
    await writeFile(join(cwd, 'island.txt'), 'x\n')
    await git(cwd, 'add', 'island.txt')
    const result = await read(cwd, 'main')
    expect(result.kind).toBe('changes')
    expect(result.kind === 'changes' ? result.changes.stagedStat : '').toContain('island.txt')
  })

  it('degrades an oversized untracked list to a bounded, non-empty excerpt', async () => {
    const cwd = await repository()
    const name = 'u'.repeat(200)
    await Promise.all(
      Array.from({ length: 400 }, (_, index) => writeFile(join(cwd, `${name}-${index}`), ''))
    )
    const result = await read(cwd)
    expect(result.kind).toBe('changes')
    const untracked = result.kind === 'changes' ? result.changes.untracked : ''
    expect(untracked.endsWith('…')).toBe(true)
    expect(untracked.length).toBeLessThanOrEqual(64 * 1024 + 2)
  })

  it('defers on a real Git error whose message mentions maxBuffer', async () => {
    const cwd = await repository()
    await writeFile(join(cwd, 'tracked.txt'), 'two\n')
    await git(cwd, 'config', 'diff.statGraphWidth', 'maxBuffer')
    await expect(read(cwd)).resolves.toEqual({ kind: 'unreadable' })
  })

  it('defers when a base call fails operationally, even with other evidence present', async () => {
    const cwd = await repository()
    // A base commit whose parent object is gone: rev-parse succeeds, merge-base cannot walk it.
    await git(cwd, 'switch', '--quiet', '--orphan', 'broken')
    await git(cwd, 'commit', '--quiet', '--allow-empty', '-m', 'lost parent')
    const lost = await git(cwd, 'rev-parse', 'HEAD')
    await git(cwd, 'commit', '--quiet', '--allow-empty', '-m', 'broken tip')
    await git(cwd, 'switch', '--quiet', 'nautilus')
    await unlink(join(cwd, '.git', 'objects', lost.slice(0, 2), lost.slice(2)))
    await writeFile(join(cwd, 'tracked.txt'), 'two\n')
    await expect(read(cwd, 'broken')).resolves.toEqual({ kind: 'unreadable' })
  })

  it('defers on abort and on an expired deadline', async () => {
    const cwd = await repository()
    await writeFile(join(cwd, 'tracked.txt'), 'two\n')
    const aborted = new AbortController()
    aborted.abort()
    await expect(read(cwd, 'main', aborted.signal)).resolves.toEqual({ kind: 'unreadable' })
    await expect(
      readBranchChangesForNaming({
        cwd,
        baseRef: 'main',
        signal: new AbortController().signal,
        deadlineAt: 0
      })
    ).resolves.toEqual({ kind: 'unreadable' })
  })
})

describe('readBranchChangesForNaming with an injected runner', () => {
  type Call = { args: string[]; options: GitExecOptions }
  const ok = (stdout: string) => Promise.resolve({ stdout })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('runs every Git read with the offline environment', async () => {
    const calls: Call[] = []
    await readBranchChangesForNaming({
      cwd: '/repo',
      baseRef: 'main',
      signal: new AbortController().signal,
      deadlineAt: Number.MAX_SAFE_INTEGER,
      runGit: (args, options) => {
        calls.push({ args, options })
        return ok(args[0] === 'rev-parse' || args[0] === 'merge-base' ? 'sha\n' : '')
      }
    })
    expect(calls).toHaveLength(6)
    for (const { options } of calls) {
      expect(options.env).toMatchObject({ GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: 'none' })
    }
  })

  it('launches no Git work once the deadline has passed, including routed retries', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_000)
    const calls: Call[] = []
    const result = await readBranchChangesForNaming({
      cwd: '/repo',
      baseRef: 'main',
      signal: new AbortController().signal,
      deadlineAt: 2_000,
      runGit: (args, options) => {
        calls.push({ args, options })
        // The deadline passes while the first read runs.
        vi.setSystemTime(2_500)
        return ok('sha\n')
      }
    })
    expect(result).toEqual({ kind: 'unreadable' })
    expect(calls.map(({ args }) => args[0])).toEqual(['rev-parse'])
    expect(calls[0]?.options.canStart?.()).toBe(false)
  })

  it('does not count clipped diagnostics as work when stdout is complete', async () => {
    const clipped = (stdout: string) =>
      Promise.reject(
        Object.assign(new Error('git produced more than 262144 bytes of output.'), {
          code: 0,
          killed: false,
          signal: null,
          outputTruncated: true,
          stdout
        })
      )
    const read = (stdout: string) =>
      readBranchChangesForNaming({
        cwd: '/repo',
        baseRef: undefined,
        signal: new AbortController().signal,
        deadlineAt: Number.MAX_SAFE_INTEGER,
        runGit: (args) => (args[0] === 'ls-files' ? ok('') : clipped(stdout))
      })
    await expect(read('')).resolves.toEqual({ kind: 'nothing-yet' })
    const atCap = await read('x'.repeat(256 * 1024))
    expect(atCap.kind === 'changes' && atCap.changes.workingStat.endsWith('…')).toBe(true)
  })
})
