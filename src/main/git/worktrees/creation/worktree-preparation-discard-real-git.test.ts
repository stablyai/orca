import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createWorktreePreparationLockReason } from '../../../../shared/worktree/creation/create-preparation'
import * as runner from '../../command-runner/git-exec-file'
import { performDiscardPreparedWorktree } from './worktree-preparation-discard'

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

  await performDiscardPreparedWorktree(repo, prepared, { signal: AbortSignal.abort() }, reason)
  await expect(readFile(lock, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  expect(
    (await runner.gitExecFileAsync(['worktree', 'list', '--porcelain'], { cwd: repo })).stdout
  ).not.toContain(prepared)
})

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
  vi.spyOn(runner, 'gitExecFileAsync').mockImplementation(async (args, options) => {
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
  expect(await readFile(lock, 'utf8')).toBe('replacement during cleanup\n')
})

it('does not borrow ownership from a different repository', async () => {
  const { repo, prepared, lock, reason } = await fixture()
  const otherRepo = join(dirname(repo), 'other-repo')
  await runner.gitExecFileAsync(['init', '--quiet', otherRepo], { cwd: dirname(repo) })
  await rm(prepared, { recursive: true })

  await expect(performDiscardPreparedWorktree(otherRepo, prepared, {}, reason)).rejects.toThrow(
    'lock owner changed'
  )
  expect(await readFile(lock, 'utf8')).toBe(`${reason}\n`)
})

it.runIf(process.platform !== 'win32')('does not follow a symlink ownership marker', async () => {
  const { repo, prepared, lock, reason } = await fixture()
  const externalLock = join(dirname(repo), 'external-lock')
  await writeFile(externalLock, `${reason}\n`)
  await rm(lock)
  await symlink(externalLock, lock)
  await rm(prepared, { recursive: true })

  await expect(performDiscardPreparedWorktree(repo, prepared, {}, reason)).rejects.toThrow(
    'lock owner changed'
  )
  expect(await readFile(externalLock, 'utf8')).toBe(`${reason}\n`)
})

it('preserves a replacement even when its ownership text was copied', async () => {
  const { repo, prepared, lock, reason } = await fixture()
  const replacement = join(dirname(repo), 'replacement')
  await runner.gitExecFileAsync(['worktree', 'add', '--detach', replacement, 'HEAD'], { cwd: repo })
  await runner.gitExecFileAsync(['worktree', 'lock', '--reason', reason, replacement], {
    cwd: repo
  })
  const pointer = await readFile(join(replacement, '.git'), 'utf8')
  await writeFile(join(prepared, '.git'), pointer)
  await writeFile(join(prepared, 'user.txt'), 'preserve replacement\n')
  await expect(performDiscardPreparedWorktree(repo, prepared, {}, reason, lock)).rejects.toThrow(
    'lock owner changed'
  )
  expect(await readFile(join(prepared, 'user.txt'), 'utf8')).toBe('preserve replacement\n')
  expect(await readFile(lock, 'utf8')).toBe(`${reason}\n`)
})

it('preserves a different missing-checkout registration with copied ownership text', async () => {
  const { repo, prepared, lock, reason } = await fixture()
  const preserved = join(dirname(repo), 'preserved-original')
  await runner.gitExecFileAsync(['worktree', 'move', '-f', '-f', prepared, preserved], {
    cwd: repo
  })
  await runner.gitExecFileAsync(
    ['worktree', 'add', '--detach', '--no-checkout', prepared, 'HEAD'],
    { cwd: repo }
  )
  await runner.gitExecFileAsync(['worktree', 'lock', '--reason', reason, prepared], { cwd: repo })
  const replacementLock = (
    await runner.gitExecFileAsync(['rev-parse', '--git-path', 'locked'], { cwd: prepared })
  ).stdout.trim()
  await rm(prepared, { recursive: true })
  await expect(performDiscardPreparedWorktree(repo, prepared, {}, reason, lock)).rejects.toThrow(
    'lock owner changed'
  )
  expect(await readFile(replacementLock, 'utf8')).toBe(`${reason}\n`)
  expect(await readFile(lock, 'utf8')).toBe(`${reason}\n`)
})
