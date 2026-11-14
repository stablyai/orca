import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createWorktreePreparationLockReason } from '../../../../shared/worktree/creation/create-preparation'
import * as runner from '../../command-runner/git-exec-file'
import {
  discardPreparedWorktree,
  finalizePreparedWorktree,
  prepareWorktreeCreateCheckout
} from './worktree-create-preparation'
import { unlockWorktreePreparation } from './worktree-preparation-lock'

import { _resetPreparationPoolForTests } from '../../../workspaces/creation/preparation/worktree-create-preparation-pool'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await _resetPreparationPoolForTests()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function git(cwd: string, args: string[]): Promise<string> {
  return (await runner.gitExecFileAsync(args, { cwd })).stdout.trim()
}

async function fixture(
  repoName = 'repo'
): Promise<{ root: string; repo: string; prepared: string; final: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orca-preparation-lock-')))
  roots.push(root)
  const repo = join(root, repoName)
  await git(root, ['init', '--quiet', repo])
  await git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  await writeFile(join(repo, 'tracked.txt'), 'original\n')
  await git(repo, ['add', 'tracked.txt'])
  await git(repo, [
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '--quiet',
    '-m',
    'initial'
  ])
  return { root, repo, prepared: join(root, 'prepared'), final: join(root, 'final') }
}

it.runIf(process.platform !== 'win32')(
  'unlocks an owned preparation whose repository path contains a newline',
  async () => {
    const { repo, prepared } = await fixture('repo\nnewline')
    const reason = createWorktreePreparationLockReason('newline-path')
    await prepareWorktreeCreateCheckout(repo, prepared, 'main', reason)
    const lock = await git(prepared, ['rev-parse', '--git-path', 'locked'])
    expect(lock).toContain('\n')
    expect(await readFile(lock, 'utf8')).toBe(`${reason}\n`)

    await unlockWorktreePreparation(prepared, reason, {})
    await expect(readFile(lock, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(prepared, 'tracked.txt'), 'utf8')).toBe('original\n')
    expect(await git(prepared, ['status', '--porcelain'])).toBe('')
  }
)

it('cleans only its newly registered marker when cancellation follows atomic add', async ({
  skip
}) => {
  const { repo, prepared } = await fixture()
  const version = (await git(repo, ['--version'])).match(/git version (\d+)\.(\d+)/)
  if (Number(version?.[1]) === 2 && Number(version?.[2]) < 33) {
    skip()
  }
  const reason = createWorktreePreparationLockReason('atomic-cancellation')
  const controller = new AbortController()
  const run = runner.gitExecFileAsync
  vi.spyOn(runner, 'gitExecFileAsync').mockImplementation(async (args, options) => {
    const result = await run(args, options)
    if (args.includes('--no-checkout') && args.includes('--reason')) {
      controller.abort()
      throw new Error('canceled after atomic add')
    }
    return result
  })
  await expect(
    prepareWorktreeCreateCheckout(repo, prepared, 'main', reason, { signal: controller.signal })
  ).rejects.toMatchObject({ name: 'AbortError' })
  await expect(readFile(join(prepared, '.git'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await git(repo, ['worktree', 'list', '--porcelain'])).not.toContain(prepared)
})

it('resolves a relative gitfile and retains a competing unlock marker', async () => {
  const { repo, prepared } = await fixture()
  const reason = createWorktreePreparationLockReason('relative')
  await prepareWorktreeCreateCheckout(repo, prepared, 'main', reason)
  const adminDir = await git(prepared, ['rev-parse', '--git-dir'])
  await writeFile(join(prepared, '.git'), `gitdir: ${relative(prepared, adminDir)}\n`)
  const lock = join(adminDir, 'locked')
  await writeFile(lock, 'manual user lock\n')
  await expect(unlockWorktreePreparation(prepared, reason, {})).rejects.toThrow(
    'lock owner changed'
  )
  expect(await readFile(lock, 'utf8')).toBe('manual user lock\n')
  expect(await git(prepared, ['rev-parse', '--verify', 'HEAD'])).toBe(
    await git(repo, ['rev-parse', 'HEAD'])
  )
})

it('claims the marker before materialization and preserves a competing owner after add', async () => {
  const { repo, prepared } = await fixture()
  const reason = createWorktreePreparationLockReason('before-materialization')
  const run = runner.gitExecFileAsync
  let lock = ''
  vi.spyOn(runner, 'gitExecFileAsync').mockImplementation(async (args, options) => {
    const result = await run(args, options)
    if (args.includes('--no-checkout')) {
      lock = (await run(['rev-parse', '--git-path', 'locked'], { cwd: prepared })).stdout.trim()
      await writeFile(lock, 'manual before materialization\n')
      await writeFile(join(prepared, 'tracked.txt'), 'user checkout content\n')
    }
    return result
  })
  await expect(prepareWorktreeCreateCheckout(repo, prepared, 'main', reason)).rejects.toThrow(
    'lock owner changed'
  )
  expect(await readFile(lock, 'utf8')).toBe('manual before materialization\n')
  expect(await readFile(join(prepared, 'tracked.txt'), 'utf8')).toBe('user checkout content\n')
})

it.each(['checkout', 'push.autoSetupRemote'])(
  'preserves the finalized checkout when its marker is replaced during %s',
  async (command) => {
    const { repo, prepared, final } = await fixture()
    const reason = createWorktreePreparationLockReason('replacement')
    await prepareWorktreeCreateCheckout(repo, prepared, 'main', reason)
    const lock = await git(prepared, ['rev-parse', '--git-path', 'locked'])
    const run = runner.gitExecFileAsync
    vi.spyOn(runner, 'gitExecFileAsync').mockImplementation(async (args, options) => {
      if (args.includes(command)) {
        await writeFile(lock, 'manual finalized lock\n')
      }
      return run(args, options)
    })
    await expect(
      finalizePreparedWorktree(repo, prepared, final, 'feature', 'main', false, {}, reason)
    ).rejects.toThrow('lock owner changed')
    expect(await readFile(lock, 'utf8')).toBe('manual finalized lock\n')
    expect(await readFile(join(final, 'tracked.txt'), 'utf8')).toBe('original\n')
    expect(await git(final, ['symbolic-ref', '--short', 'HEAD'])).toBe('feature')
  }
)

it('leaves a replacement owner untouched before any reset, move, or branch attachment', async () => {
  const { repo, prepared, final } = await fixture()
  const reason = createWorktreePreparationLockReason('replaced-before-finalize')
  await prepareWorktreeCreateCheckout(repo, prepared, 'main', reason)
  const lock = await git(prepared, ['rev-parse', '--git-path', 'locked'])
  await writeFile(lock, 'manual replacement\n')
  await writeFile(join(prepared, 'tracked.txt'), 'user edits\n')
  await expect(
    finalizePreparedWorktree(repo, prepared, final, 'feature', 'main', false, {}, reason)
  ).rejects.toThrow('lock owner changed')
  expect(await readFile(lock, 'utf8')).toBe('manual replacement\n')
  expect(await readFile(join(prepared, 'tracked.txt'), 'utf8')).toBe('user edits\n')
  expect(await git(repo, ['branch', '--list', 'feature'])).toBe('')
})

it('checks replacement ownership after move before attaching a branch', async () => {
  const { repo, prepared, final } = await fixture()
  const reason = createWorktreePreparationLockReason('replaced-after-move')
  await prepareWorktreeCreateCheckout(repo, prepared, 'main', reason)
  const lock = await git(prepared, ['rev-parse', '--git-path', 'locked'])
  const run = runner.gitExecFileAsync
  vi.spyOn(runner, 'gitExecFileAsync').mockImplementation(async (args, options) => {
    const result = await run(args, options)
    if (args.includes('move')) {
      await writeFile(lock, 'manual moved lock\n')
    }
    return result
  })
  await expect(
    finalizePreparedWorktree(repo, prepared, final, 'feature', 'main', false, {}, reason)
  ).rejects.toThrow('lock owner changed')
  expect(await readFile(lock, 'utf8')).toBe('manual moved lock\n')
  expect(await git(final, ['symbolic-ref', '--quiet', 'HEAD']).catch(() => 'detached')).toBe(
    'detached'
  )
  expect(await git(repo, ['branch', '--list', 'feature'])).toBe('')
})

it('refuses a force discard after the marker was replaced', async () => {
  const { repo, prepared } = await fixture()
  const reason = createWorktreePreparationLockReason('discard-replacement')
  await prepareWorktreeCreateCheckout(repo, prepared, 'main', reason)
  const lock = await git(prepared, ['rev-parse', '--git-path', 'locked'])
  await writeFile(lock, 'manual discard lock\n')
  await expect(discardPreparedWorktree(repo, prepared, {}, reason)).rejects.toThrow(
    'lock owner changed'
  )
  expect(await readFile(lock, 'utf8')).toBe('manual discard lock\n')
  expect(await readFile(join(prepared, 'tracked.txt'), 'utf8')).toBe('original\n')
})
