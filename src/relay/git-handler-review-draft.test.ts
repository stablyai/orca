import { readFile, unlink, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as processRunner from '@orca/process-host'
import { GitAdmissionScheduler } from '../shared/git-admission-scheduler'
import { GIT_READ_TIMEOUT_MS } from '../shared/git-command-timeout'
import type { GitHandler } from './git-handler'
import type { GitHandlerOperationHost } from './git-handler-operation-context'
import {
  createGitHandlerRelay,
  createGitTempDir,
  removeGitTempDir
} from './git-handler-test-harness'
import { gitCommit, gitInit, type MockDispatcher } from './git-handler-test-setup'
import { _resetRelayGitAdmissionForTests } from './git-handler-command-termination'

const BASE_OID = 'a'.repeat(40)
const commandResult = { stdout: 'M\tfile.txt\n', stderr: '' }
const processResult = { ...commandResult, code: 0, signal: null, timedOut: false }

function checkedCommandResult(result: unknown): { stdout: string; stderr: string } {
  if (
    !result ||
    typeof result !== 'object' ||
    !('stdout' in result) ||
    typeof result.stdout !== 'string' ||
    !('stderr' in result) ||
    typeof result.stderr !== 'string'
  ) {
    throw new Error('Expected the review diff command response')
  }
  return { stdout: result.stdout, stderr: result.stderr }
}

describe.each([2, 4])('relay review draft diff with %i Git slots', (generalCap) => {
  let dispatcher: MockDispatcher
  let handler: GitHandler
  let repo: string
  let scheduler: GitAdmissionScheduler

  beforeEach(() => {
    scheduler = new GitAdmissionScheduler({ generalCap, generalHeadroom: 0 })
    _resetRelayGitAdmissionForTests(scheduler)
    repo = createGitTempDir()
    ;({ dispatcher, handler } = createGitHandlerRelay())
  })

  afterEach(async () => {
    handler.dispose()
    vi.restoreAllMocks()
    try {
      await removeGitTempDir(repo)
      expect(scheduler.snapshot().queued).toBe(0)
      expect(
        Object.values(scheduler.snapshot().budgets).every(
          (budget) => budget.baseUsed === 0 && budget.headroomUsed === 0
        )
      ).toBe(true)
    } finally {
      _resetRelayGitAdmissionForTests()
    }
  })

  function reviewDiff(overrides: Record<string, unknown> = {}, signal?: AbortSignal) {
    return dispatcher.callRequest(
      'git.reviewDiff',
      { worktreePath: repo, mergeBase: BASE_OID, format: 'name-status', ...overrides },
      { isStale: () => false, signal }
    )
  }

  async function runRepoGit(args: string[]): Promise<string> {
    const result = await processRunner.runProcess({ program: 'git', args, cwd: repo })
    if (result.code !== 0) {
      throw new Error(result.stderr || `Git fixture command failed: ${args[0]}`)
    }
    return result.stdout
  }

  it.each([
    { worktreePath: undefined },
    { worktreePath: null },
    { worktreePath: 1 },
    { worktreePath: '' },
    { worktreePath: 'repo\0other' },
    { mergeBase: undefined },
    { mergeBase: null },
    { mergeBase: 'main' },
    { mergeBase: 'HEAD~1..HEAD' },
    { mergeBase: '--output=result.patch' },
    { mergeBase: 'a'.repeat(39) },
    { mergeBase: 'a'.repeat(41) },
    { mergeBase: 'a'.repeat(63) },
    { mergeBase: 'a'.repeat(65) },
    { mergeBase: 'g'.repeat(40) },
    { mergeBase: `${BASE_OID}\0` },
    { format: undefined },
    { format: null },
    { format: '' },
    { format: 'raw' },
    { format: ['patch'] },
    { format: '--output=result.patch' }
  ])('rejects malformed request fields before running Git: %j', async (overrides) => {
    const git = vi.fn<GitHandlerOperationHost['git']>().mockResolvedValue(commandResult)
    Object.assign(handler, { git })

    await expect(reviewDiff(overrides)).rejects.toThrow('Invalid review diff request.')
    expect(git).not.toHaveBeenCalled()
  })

  it.each([
    { format: 'name-status', mergeBase: BASE_OID, flags: ['--name-status'] },
    {
      format: 'patch',
      mergeBase: 'A'.repeat(64),
      flags: ['--patch', '--minimal', '--no-color', '--no-ext-diff']
    }
  ])('routes $format through the fixed command with a full object id', async (request) => {
    const git = vi.fn<GitHandlerOperationHost['git']>().mockResolvedValue(commandResult)
    Object.assign(handler, { git })
    const controller = new AbortController()

    await expect(
      reviewDiff(
        { ...request, args: ['fetch', 'origin'], filePath: 'other.txt', timeout: 0 },
        controller.signal
      )
    ).resolves.toEqual(commandResult)
    expect(git).toHaveBeenCalledExactlyOnceWith(
      ['diff', ...request.flags, `${request.mergeBase}..HEAD`, '--'],
      repo,
      { signal: controller.signal, disableOptionalLocks: true }
    )
  })

  it.each([
    ['fetch', 'origin'],
    ['range-diff', 'HEAD~2..HEAD~1', 'HEAD~1..HEAD'],
    ['diff', '--name-status', `${BASE_OID}..HEAD`],
    ['diff', '--cached', '--patch', `${BASE_OID}..HEAD`]
  ])('keeps generic git.exec restricted for %j', async (...args) => {
    const git = vi.fn<GitHandlerOperationHost['git']>().mockResolvedValue(commandResult)
    Object.assign(handler, { git })

    await expect(dispatcher.callRequest('git.exec', { args, cwd: repo })).rejects.toThrow(
      /not allowed|restricted to staged changes/
    )
    expect(git).not.toHaveBeenCalled()
  })

  it('passes the existing read timeout and cancellation signal to the process runner', async () => {
    const runProcess = vi.spyOn(processRunner, 'runProcess').mockImplementation(async (spec) => {
      spec.onChildTerminated?.()
      return processResult
    })
    const controller = new AbortController()

    await expect(reviewDiff({ timeout: 0 }, controller.signal)).resolves.toEqual(commandResult)
    expect(runProcess).toHaveBeenCalledTimes(1)
    const spec = runProcess.mock.calls[0]?.[0]
    expect(spec?.program).toBe('git')
    expect(spec?.args).toEqual(['diff', '--name-status', `${BASE_OID}..HEAD`, '--'])
    expect(spec?.cwd).toBe(repo)
    expect(spec?.signal).toBe(controller.signal)
    expect(spec?.timeoutMs).toBe(GIT_READ_TIMEOUT_MS)
    expect(spec?.terminationBarrier).toBe(true)
    expect(spec?.env?.GIT_OPTIONAL_LOCKS).toBe('0')
  })

  it('rejects a read that crossed its timeout instead of returning a partial diff', async () => {
    vi.spyOn(processRunner, 'runProcess').mockImplementation(async (spec) => {
      spec.onChildTerminated?.()
      return { ...processResult, timedOut: true }
    })

    await expect(reviewDiff()).rejects.toMatchObject({ timedOut: true })
  })

  it('holds a timed-out read grant until the child termination is reported', async () => {
    let reportTermination: (() => void) | undefined
    vi.spyOn(processRunner, 'runProcess').mockImplementation(async (spec) => {
      reportTermination = spec.onChildTerminated
      expect(spec.terminationBarrier).toBe(true)
      return { ...processResult, timedOut: true }
    })

    try {
      await expect(reviewDiff()).rejects.toMatchObject({ timedOut: true })
      expect(reportTermination).toBeTypeOf('function')
      expect(scheduler.snapshot().budgets.general?.baseUsed).toBe(1)
    } finally {
      reportTermination?.()
    }
    expect(scheduler.snapshot().budgets.general?.baseUsed).toBe(0)
  })

  it('rejects cancellation before spawning any Git process', async () => {
    const runProcess = vi.spyOn(processRunner, 'runProcess')
    const controller = new AbortController()
    controller.abort()

    await expect(reviewDiff({}, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(runProcess).not.toHaveBeenCalled()
  })

  it('rejects a completed read when the request was cancelled during execution', async () => {
    const controller = new AbortController()
    vi.spyOn(processRunner, 'runProcess').mockImplementation(async (spec) => {
      expect(spec.signal).toBe(controller.signal)
      controller.abort()
      spec.onChildTerminated?.()
      return processResult
    })

    await expect(reviewDiff({}, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('checks cancellation again before publishing a successful command response', async () => {
    const controller = new AbortController()
    const reason = new Error('Draft request cancelled')
    const git = vi.fn<GitHandlerOperationHost['git']>(async () => {
      controller.abort(reason)
      return commandResult
    })
    Object.assign(handler, { git })

    await expect(reviewDiff({}, controller.signal)).rejects.toBe(reason)
  })

  it('reads only committed changes and preserves dirty files, the index, and HEAD', async () => {
    gitInit(repo)
    await writeFile(path.join(repo, 'file.txt'), 'base\n')
    await writeFile(path.join(repo, 'removed.txt'), 'removed\n')
    gitCommit(repo, 'base')
    const mergeBase = (await runRepoGit(['rev-parse', 'HEAD'])).trim()
    await writeFile(path.join(repo, 'file.txt'), 'committed\n')
    await writeFile(path.join(repo, 'added.txt'), 'added\n')
    await unlink(path.join(repo, 'removed.txt'))
    gitCommit(repo, 'feature')
    await writeFile(path.join(repo, 'file.txt'), 'staged\n')
    await runRepoGit(['add', 'file.txt'])
    await writeFile(path.join(repo, 'file.txt'), 'unstaged\n')
    await writeFile(path.join(repo, 'untracked.txt'), 'untracked\n')
    await runRepoGit(['config', 'color.ui', 'always'])
    await runRepoGit(['config', 'diff.external', path.join(repo, 'must-not-run')])
    const indexBefore = await readFile(path.join(repo, '.git', 'index'))
    const statusBefore = await runRepoGit(['status', '--porcelain'])
    const headBefore = await runRepoGit(['rev-parse', 'HEAD'])

    const names = checkedCommandResult(await reviewDiff({ mergeBase }))
    const patch = checkedCommandResult(await reviewDiff({ mergeBase, format: 'patch' }))

    expect(names.stdout).toBe('A\tadded.txt\nM\tfile.txt\nD\tremoved.txt\n')
    expect(patch.stdout).toContain('-base\n+committed\n')
    expect(patch.stdout).toContain('new file mode')
    expect(patch.stdout).toContain('deleted file mode')
    expect(patch.stdout).not.toMatch(/staged|unstaged|untracked/)
    expect(patch.stdout).not.toContain('\u001b[')
    expect(names.stderr).toBe('')
    expect(patch.stderr).toBe('')
    expect(await readFile(path.join(repo, '.git', 'index'))).toEqual(indexBefore)
    expect(await runRepoGit(['status', '--porcelain'])).toBe(statusBefore)
    expect(await runRepoGit(['rev-parse', 'HEAD'])).toBe(headBefore)
    expect(await readFile(path.join(repo, 'file.txt'), 'utf8')).toBe('unstaged\n')
  })
})
