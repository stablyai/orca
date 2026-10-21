import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createWorktreePreparationLockReason } from '../../shared/worktree/create-preparation'
import * as runner from './runner'
import { performDiscardPreparedWorktree } from './worktree-preparation-discard'
import { WORKTREE_REMOVAL_REGISTRATION_TIMEOUT_MS } from './worktree-operation-options'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<{
  repo: string
  prepared: string
  lock: string
  reason: string
}> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orca-discard-registration-')))
  roots.push(root)
  const repo = join(root, 'repo')
  const prepared = join(root, 'prepared')
  const reason = createWorktreePreparationLockReason('deleted-checkout')
  const git = async (cwd: string, args: string[]): Promise<string> =>
    (await runner.gitExecFileAsync(args, { cwd })).stdout.trim()
  await git(root, ['init', '--quiet', repo])
  await git(repo, [
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '--allow-empty',
    '--quiet',
    '-m',
    'initial'
  ])
  await git(repo, ['worktree', 'add', '--detach', '--no-checkout', prepared, 'HEAD'])
  await git(repo, ['worktree', 'lock', '--reason', reason, prepared])
  const lock = await git(prepared, ['rev-parse', '--git-path', 'locked'])
  return { repo, prepared, lock, reason }
}

it('removes only the owned registration after external deletion of its checkout', async () => {
  const { repo, prepared, lock, reason } = await fixture()
  await rm(prepared, { recursive: true })
  expect(await readFile(lock, 'utf8')).toBe(`${reason}\n`)
  const spy = vi.spyOn(runner, 'gitExecFileAsync')

  await performDiscardPreparedWorktree(repo, prepared, { signal: AbortSignal.abort() }, reason)

  expect(spy.mock.calls.map(([args]) => args)).toEqual([
    ['rev-parse', '--git-path', 'locked', '--git-common-dir'],
    ['worktree', 'remove', '--force', '--force', prepared]
  ])
  expect(spy.mock.calls[1]?.[1]).toEqual({
    cwd: repo,
    timeout: WORKTREE_REMOVAL_REGISTRATION_TIMEOUT_MS
  })
  await expect(readFile(lock, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  expect(
    (await runner.gitExecFileAsync(['worktree', 'list', '--porcelain'], { cwd: repo })).stdout
  ).not.toContain(prepared)
})

it.each(['foreign', 'empty', 'missing', 'unterminated', 'CRLF'])(
  'preserves a missing checkout registration with a %s ownership marker',
  async (kind) => {
    const { repo, prepared, lock, reason } = await fixture()
    const contents =
      kind === 'foreign'
        ? 'manual lock\n'
        : kind === 'empty'
          ? ''
          : `${reason}${kind === 'CRLF' ? '\r\n' : ''}`
    await (kind === 'missing' ? rm(lock) : writeFile(lock, contents))
    await rm(prepared, { recursive: true })
    const spy = vi.spyOn(runner, 'gitExecFileAsync')

    await expect(performDiscardPreparedWorktree(repo, prepared, {}, reason)).rejects.toThrow(
      'lock owner changed'
    )

    expect(spy.mock.calls.some(([args]) => args.includes('remove'))).toBe(false)
    expect(await readFile(join(dirname(lock), 'gitdir'), 'utf8')).toBe(
      `${join(prepared, '.git')}\n`
    )
    if (kind !== 'missing') {
      expect(await readFile(lock, 'utf8')).toBe(contents)
    }
  }
)

it('preserves a folder that reappears between ownership verification and Git removal', async () => {
  const { repo, prepared, lock, reason } = await fixture()
  await rm(prepared, { recursive: true })
  const run = runner.gitExecFileAsync
  vi.spyOn(runner, 'gitExecFileAsync').mockImplementation(async (args, options) => {
    if (args.includes('remove')) {
      await mkdir(prepared)
      await writeFile(join(prepared, 'user.txt'), 'preserve this folder\n')
    }
    return run(args, options)
  })

  await expect(performDiscardPreparedWorktree(repo, prepared, {}, reason)).rejects.toThrow(
    'validation failed'
  )

  expect(await readFile(lock, 'utf8')).toBe(`${reason}\n`)
  expect(await readFile(join(prepared, 'user.txt'), 'utf8')).toBe('preserve this folder\n')
})

it('rechecks an owner replaced after the checkout path query fails', async () => {
  const { repo, prepared, lock, reason } = await fixture()
  await rm(prepared, { recursive: true })
  const run = runner.gitExecFileAsync
  const spy = vi.spyOn(runner, 'gitExecFileAsync').mockImplementation(async (args, options) => {
    try {
      return await run(args, options)
    } catch (error) {
      if (options?.cwd === prepared) {
        await writeFile(lock, 'replacement during cleanup\n')
      }
      throw error
    }
  })

  await expect(performDiscardPreparedWorktree(repo, prepared, {}, reason)).rejects.toThrow(
    'lock owner changed'
  )

  expect(spy.mock.calls.some(([args]) => args.includes('remove'))).toBe(false)
  expect(await readFile(lock, 'utf8')).toBe('replacement during cleanup\n')
})

it('does not borrow ownership from a different repository', async () => {
  const { repo, prepared, lock, reason } = await fixture()
  const otherRepo = join(dirname(repo), 'other-repo')
  await runner.gitExecFileAsync(['init', '--quiet', otherRepo], { cwd: dirname(repo) })
  await rm(prepared, { recursive: true })
  const spy = vi.spyOn(runner, 'gitExecFileAsync')

  await expect(performDiscardPreparedWorktree(otherRepo, prepared, {}, reason)).rejects.toThrow(
    'lock owner changed'
  )

  expect(spy.mock.calls.some(([args]) => args.includes('remove'))).toBe(false)
  expect(await readFile(lock, 'utf8')).toBe(`${reason}\n`)
})

it.runIf(process.platform !== 'win32')('does not follow a symlink ownership marker', async () => {
  const { repo, prepared, lock, reason } = await fixture()
  const externalLock = join(dirname(repo), 'external-lock')
  await writeFile(externalLock, `${reason}\n`)
  await rm(lock)
  await symlink(externalLock, lock)
  await rm(prepared, { recursive: true })
  const spy = vi.spyOn(runner, 'gitExecFileAsync')

  await expect(performDiscardPreparedWorktree(repo, prepared, {}, reason)).rejects.toThrow(
    'lock owner changed'
  )

  expect(spy.mock.calls.some(([args]) => args.includes('remove'))).toBe(false)
  expect(await readFile(externalLock, 'utf8')).toBe(`${reason}\n`)
})
