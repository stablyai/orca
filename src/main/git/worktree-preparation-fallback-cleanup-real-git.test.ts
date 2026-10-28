import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createWorktreePreparationLockReason } from '../../shared/worktree/create-preparation'
import { clearGitCapabilityStateForTests, getLocalGitCapabilityCache } from './git-capability-state'
import * as runner from './runner'
import { prepareWorktreeCreateCheckout } from './worktree-create-preparation'
import { WORKTREE_REMOVAL_REGISTRATION_TIMEOUT_MS } from './worktree-operation-options'

const roots: string[] = []
const unsupported = Object.assign(new Error("error: unknown option 'reason'"), { code: 129 })

beforeEach(() => {
  clearGitCapabilityStateForTests()
})

afterEach(async () => {
  vi.restoreAllMocks()
  clearGitCapabilityStateForTests()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function git(cwd: string, args: string[]): Promise<string> {
  return (await runner.gitExecFileAsync(args, { cwd })).stdout.trim()
}

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orca-fallback-cleanup-')))
  roots.push(root)
  const repo = join(root, 'repo')
  const prepared = join(root, 'prepared')
  await git(root, ['init', '--quiet', repo])
  await git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  await writeFile(join(repo, 'tracked.txt'), 'original\n')
  await git(repo, ['add', 'tracked.txt'])
  await git(repo, [
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'initial'
  ])
  return { repo, prepared }
}

it.each([
  ['first', 'cancellation'],
  ['cached', 'cancellation'],
  ['first', 'path probe'],
  ['cached', 'path probe']
])('reclaims its registered %s fallback after %s before locking', async (fallback, failureKind) => {
  const { repo, prepared } = await fixture()
  const reason = createWorktreePreparationLockReason('fallback-cleanup')
  const controller = new AbortController()
  const failure = new Error(`${failureKind} after completed add`)
  const run = runner.gitExecFileAsync
  let registered = false
  if (fallback === 'cached') {
    getLocalGitCapabilityCache().rememberUnsupported('worktree-add-lock-reason')
  }
  const spy = vi.spyOn(runner, 'gitExecFileAsync').mockImplementation(async (args, options) => {
    if (args.includes('--reason')) {
      throw unsupported
    }
    const result = await run(args, options)
    if (args.includes('--no-checkout')) {
      registered = true
      expect(existsSync(join(prepared, '.git'))).toBe(true)
    }
    if (registered && options?.cwd === prepared && args.includes('--git-path')) {
      expect(existsSync(join(prepared, 'tracked.txt'))).toBe(false)
      if (failureKind === 'cancellation') {
        controller.abort(failure)
      }
      throw failure
    }
    return result
  })
  await expect(
    prepareWorktreeCreateCheckout(repo, prepared, 'main', reason, {
      signal: controller.signal,
      timeout: 180_000
    })
  ).rejects.toBe(failure)
  const removals = spy.mock.calls.filter(([args]) => args.includes('remove'))
  expect(removals).toHaveLength(1)
  const [removeArgs, removeOptions] = removals[0]!
  expect(removeArgs.filter((arg) => arg === '--force')).toHaveLength(1)
  expect(removeOptions).toMatchObject({
    cwd: repo,
    timeout: WORKTREE_REMOVAL_REGISTRATION_TIMEOUT_MS
  })
  expect(removeOptions).not.toHaveProperty('signal')
  expect(spy.mock.calls.some(([args]) => args.includes('reset'))).toBe(false)
  expect(existsSync(prepared)).toBe(false)
  expect((await run(['worktree', 'list', '--porcelain'], { cwd: repo })).stdout).not.toContain(
    prepared
  )
})

it.each(['first', 'cached'])(
  'preserves another marker after a successful %s fallback add',
  async (fallback) => {
    const { repo, prepared } = await fixture()
    const reason = createWorktreePreparationLockReason('competing-fallback')
    const run = runner.gitExecFileAsync
    let lock = ''
    if (fallback === 'cached') {
      getLocalGitCapabilityCache().rememberUnsupported('worktree-add-lock-reason')
    }
    const spy = vi.spyOn(runner, 'gitExecFileAsync').mockImplementation(async (args, options) => {
      if (args.includes('--reason')) {
        throw unsupported
      }
      const result = await run(args, options)
      if (args.includes('--no-checkout')) {
        lock = (await run(['rev-parse', '--git-path', 'locked'], { cwd: prepared })).stdout.trim()
        await writeFile(lock, 'manual competing owner\n')
        await writeFile(join(prepared, 'user.txt'), 'preserve this file\n')
      }
      return result
    })
    await expect(prepareWorktreeCreateCheckout(repo, prepared, 'main', reason)).rejects.toThrow(
      'lock owner changed'
    )
    expect(await readFile(lock, 'utf8')).toBe('manual competing owner\n')
    expect(await readFile(join(prepared, 'user.txt'), 'utf8')).toBe('preserve this file\n')
    expect(spy.mock.calls.some(([args]) => args.includes('remove') || args.includes('reset'))).toBe(
      false
    )
    expect((await run(['worktree', 'list', '--porcelain'], { cwd: repo })).stdout).toContain(
      prepared
    )
  }
)

it.each(['first', 'cached'])(
  'lets Git protect a competing lock from %s fallback cleanup after a generic probe failure',
  async (fallback) => {
    const { repo, prepared } = await fixture()
    const reason = createWorktreePreparationLockReason('protected-fallback-cleanup')
    const failure = new Error('lock path became unreadable')
    const run = runner.gitExecFileAsync
    let lock = ''
    if (fallback === 'cached') {
      getLocalGitCapabilityCache().rememberUnsupported('worktree-add-lock-reason')
    }
    const spy = vi.spyOn(runner, 'gitExecFileAsync').mockImplementation(async (args, options) => {
      if (args.includes('--reason')) {
        throw unsupported
      }
      if (lock && options?.cwd === prepared && args.includes('--git-path')) {
        throw failure
      }
      const result = await run(args, options)
      if (args.includes('--no-checkout')) {
        lock = (await run(['rev-parse', '--git-path', 'locked'], { cwd: prepared })).stdout.trim()
        await writeFile(lock, 'manual protected owner\n')
        await writeFile(join(prepared, 'user.txt'), 'preserve after cleanup attempt\n')
      }
      return result
    })
    await expect(prepareWorktreeCreateCheckout(repo, prepared, 'main', reason)).rejects.toBe(
      failure
    )
    const removals = spy.mock.calls.filter(([args]) => args.includes('remove'))
    expect(removals).toHaveLength(1)
    expect(removals[0]![0].filter((arg) => arg === '--force')).toHaveLength(1)
    expect(removals[0]![1]).not.toHaveProperty('signal')
    expect(removals[0]![1]).toMatchObject({ timeout: WORKTREE_REMOVAL_REGISTRATION_TIMEOUT_MS })
    expect(await readFile(lock, 'utf8')).toBe('manual protected owner\n')
    expect(await readFile(join(prepared, 'user.txt'), 'utf8')).toBe(
      'preserve after cleanup attempt\n'
    )
    expect(spy.mock.calls.some(([args]) => args.includes('reset'))).toBe(false)
    expect((await run(['worktree', 'list', '--porcelain'], { cwd: repo })).stdout).toContain(
      prepared
    )
  }
)

it('preserves a pre-existing empty target if its cached fallback lock-path probe fails', async () => {
  const { repo, prepared } = await fixture()
  await mkdir(prepared)
  getLocalGitCapabilityCache().rememberUnsupported('worktree-add-lock-reason')
  const failure = new Error('pre-existing target lock path unavailable')
  const run = runner.gitExecFileAsync
  const spy = vi.spyOn(runner, 'gitExecFileAsync').mockImplementation(async (args, options) => {
    if (options?.cwd === prepared && args.includes('--git-path')) {
      throw failure
    }
    return run(args, options)
  })
  await expect(prepareWorktreeCreateCheckout(repo, prepared, 'main', 'reason')).rejects.toBe(
    failure
  )
  expect(existsSync(join(prepared, '.git'))).toBe(true)
  expect(spy.mock.calls.some(([args]) => args.includes('remove') || args.includes('reset'))).toBe(
    false
  )
  expect((await run(['worktree', 'list', '--porcelain'], { cwd: repo })).stdout).toContain(prepared)
})
