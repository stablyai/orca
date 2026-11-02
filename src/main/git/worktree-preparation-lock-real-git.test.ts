import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createWorktreePreparationLockReason } from '../../shared/worktree/create-preparation'
import * as runner from './runner'
import {
  discardPreparedWorktree,
  finalizePreparedWorktree,
  prepareWorktreeCreateCheckout
} from './worktree-create-preparation'
import { unlockWorktreePreparation } from './worktree-preparation-lock'
import { readWorktreeList } from './worktree-list-reader'
import {
  _resetPreparationPoolForTests,
  listPreparations,
  startPreparation,
  WORKTREE_CREATE_PREPARATION_TTL_MS
} from '../worktree-create-preparation-pool'

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

it('creates and consumes its marker without worktree lock or unlock inventory scans', async () => {
  const { repo, prepared, final } = await fixture()
  const reason = createWorktreePreparationLockReason('targeted')
  const spy = vi.spyOn(runner, 'gitExecFileAsync')
  await prepareWorktreeCreateCheckout(repo, prepared, 'main', reason)
  const lock = await git(prepared, ['rev-parse', '--git-path', 'locked'])
  expect(await readFile(lock, 'utf8')).toBe(`${reason}\n`)
  spy.mockClear()
  await finalizePreparedWorktree(repo, prepared, final, 'feature', 'main', false, {}, reason)
  const lockQueries = spy.mock.calls.filter(
    ([args]) => args.includes('--git-path') || args.includes('--git-common-dir')
  )
  expect(lockQueries).toHaveLength(1)
  expect(lockQueries[0]?.[0]).toEqual(['rev-parse', '--git-path', 'locked', '--git-common-dir'])
  expect(await git(final, ['symbolic-ref', '--short', 'HEAD'])).toBe('feature')
  expect(await git(final, ['status', '--porcelain'])).toBe('')
  expect(await readFile(join(final, 'tracked.txt'), 'utf8')).toBe('original\n')
  await expect(readFile(lock, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  expect(spy.mock.calls.some(([args]) => args.includes('lock') || args.includes('unlock'))).toBe(
    false
  )
})

it.runIf(process.platform !== 'win32')(
  'unlocks an owned preparation whose repository path contains a newline',
  async () => {
    const { repo, prepared } = await fixture('repo\nnewline')
    const reason = createWorktreePreparationLockReason('newline-path')
    await prepareWorktreeCreateCheckout(repo, prepared, 'main', reason)
    const lock = await git(prepared, ['rev-parse', '--git-path', 'locked'])
    expect(lock).toContain('\n')
    expect(await readFile(lock, 'utf8')).toBe(`${reason}\n`)
    const spy = vi.spyOn(runner, 'gitExecFileAsync')

    await unlockWorktreePreparation(prepared, reason, {})
    expect(spy.mock.calls.map(([args]) => args)).toEqual([
      ['rev-parse', '--git-path', 'locked', '--git-common-dir'],
      ['rev-parse', '--git-path', 'locked'],
      ['rev-parse', '--git-common-dir']
    ])
    await expect(readFile(lock, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(prepared, 'tracked.txt'), 'utf8')).toBe('original\n')
    expect(await git(prepared, ['status', '--porcelain'])).toBe('')
  }
)

it('has its exact ownership marker before the atomic add returns', async () => {
  const { repo, prepared } = await fixture()
  const reason = createWorktreePreparationLockReason('atomic-add')
  const run = runner.gitExecFileAsync
  let observed = false
  vi.spyOn(runner, 'gitExecFileAsync').mockImplementation(async (args, options) => {
    const result = await run(args, options)
    if (args.includes('--reason')) {
      const lock = (
        await run(['rev-parse', '--git-path', 'locked'], { cwd: prepared })
      ).stdout.trim()
      expect(await readFile(lock, 'utf8')).toBe(`${reason}\n`)
      await expect(readFile(join(prepared, 'tracked.txt'))).rejects.toMatchObject({
        code: 'ENOENT'
      })
      observed = true
    }
    return result
  })
  await prepareWorktreeCreateCheckout(repo, prepared, 'main', reason)
  const version = await git(repo, ['--version'])
  const minor = Number(version.match(/git version 2\.(\d+)/)?.[1])
  expect(observed).toBe(minor >= 33)
})

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
  const spy = vi.spyOn(runner, 'gitExecFileAsync').mockImplementation(async (args, options) => {
    const result = await run(args, options)
    if (args.includes('--no-checkout') && args.includes('--reason')) {
      controller.abort()
      throw new Error('canceled after atomic add')
    }
    return result
  })
  await expect(
    prepareWorktreeCreateCheckout(repo, prepared, 'main', reason, { signal: controller.signal })
  ).rejects.toThrow('canceled after atomic add')
  expect(spy.mock.calls.some(([args]) => args.includes('reset'))).toBe(false)
  await expect(readFile(join(prepared, '.git'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await git(repo, ['worktree', 'list', '--porcelain'])).not.toContain(prepared)
})

it('preserves an existing owned checkout when another add fails at its path', async () => {
  const { repo, prepared } = await fixture()
  const reason = createWorktreePreparationLockReason('existing-add')
  await prepareWorktreeCreateCheckout(repo, prepared, 'main', reason)
  const lock = await git(prepared, ['rev-parse', '--git-path', 'locked'])
  const spy = vi.spyOn(runner, 'gitExecFileAsync')
  await expect(prepareWorktreeCreateCheckout(repo, prepared, 'main', reason)).rejects.toThrow()
  expect(spy.mock.calls.some(([args]) => args.includes('remove'))).toBe(false)
  expect(await readFile(lock, 'utf8')).toBe(`${reason}\n`)
  expect(await readFile(join(prepared, 'tracked.txt'), 'utf8')).toBe('original\n')
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

it('preserves a competing marker and registration through preparation failure and pool reset', async () => {
  const { root, repo } = await fixture()
  let prepared = ''
  let lock = ''
  const run = runner.gitExecFileAsync
  vi.spyOn(runner, 'gitExecFileAsync').mockImplementation(async (args, options) => {
    const result = await run(args, options)
    if (args.includes('reset') && options?.cwd) {
      prepared = options.cwd
      lock = (await run(['rev-parse', '--git-path', 'locked'], options)).stdout.trim()
      await writeFile(lock, 'manual competing preparation\n')
    }
    return result
  })
  await expect(
    startPreparation({
      repoPath: repo,
      workspaceRoot: root,
      baseBranch: 'main',
      canonicalBase: 'refs/heads/main',
      options: {}
    })
  ).rejects.toThrow('lock owner changed')
  await _resetPreparationPoolForTests()
  expect(await readFile(lock, 'utf8')).toBe('manual competing preparation\n')
  expect(await readFile(join(prepared, 'tracked.txt'), 'utf8')).toBe('original\n')
  expect(await readWorktreeList(repo)).toContainEqual(
    expect.objectContaining({
      path: prepared,
      locked: true,
      lockReason: 'manual competing preparation'
    })
  )
})

it('claims the marker before materialization and preserves a competing owner after add', async () => {
  const { repo, prepared } = await fixture()
  const reason = createWorktreePreparationLockReason('before-materialization')
  const run = runner.gitExecFileAsync
  let lock = ''
  const spy = vi.spyOn(runner, 'gitExecFileAsync').mockImplementation(async (args, options) => {
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
  expect(spy.mock.calls.some(([args]) => args.includes('reset') || args.includes('remove'))).toBe(
    false
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
  const spy = vi.spyOn(runner, 'gitExecFileAsync')
  await expect(
    finalizePreparedWorktree(repo, prepared, final, 'feature', 'main', false, {}, reason)
  ).rejects.toThrow('lock owner changed')
  expect(
    spy.mock.calls.some(
      ([args]) => args.includes('reset') || args.includes('move') || args.includes('checkout')
    )
  ).toBe(false)
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
  const spy = vi.spyOn(runner, 'gitExecFileAsync').mockImplementation(async (args, options) => {
    const result = await run(args, options)
    if (args.includes('move')) {
      await writeFile(lock, 'manual moved lock\n')
    }
    return result
  })
  await expect(
    finalizePreparedWorktree(repo, prepared, final, 'feature', 'main', false, {}, reason)
  ).rejects.toThrow('lock owner changed')
  expect(
    spy.mock.calls.some(([args]) => args.includes('checkout') || args.includes('remove'))
  ).toBe(false)
  expect(await readFile(lock, 'utf8')).toBe('manual moved lock\n')
  expect(await git(final, ['symbolic-ref', '--quiet', 'HEAD']).catch(() => 'detached')).toBe(
    'detached'
  )
  expect(await git(repo, ['branch', '--list', 'feature'])).toBe('')
})

it.each(['replacement', 'missing'])(
  'preserves checkout and branch if failure cleanup finds a %s marker',
  async (marker) => {
    const { repo, prepared, final } = await fixture()
    const reason = createWorktreePreparationLockReason('failure-cleanup')
    await prepareWorktreeCreateCheckout(repo, prepared, 'main', reason)
    const lock = await git(prepared, ['rev-parse', '--git-path', 'locked'])
    const run = runner.gitExecFileAsync
    vi.spyOn(runner, 'gitExecFileAsync').mockImplementation(async (args, options) => {
      const result = await run(args, options)
      if (args.includes('checkout')) {
        await (marker === 'replacement' ? writeFile(lock, 'manual failed lock\n') : rm(lock))
        throw new Error('injected checkout failure')
      }
      return result
    })
    await expect(
      finalizePreparedWorktree(repo, prepared, final, 'feature', 'main', false, {}, reason)
    ).rejects.toThrow('injected checkout failure')
    expect(await readFile(join(final, 'tracked.txt'), 'utf8')).toBe('original\n')
    expect(await git(final, ['symbolic-ref', '--short', 'HEAD'])).toBe('feature')
    expect(await git(repo, ['branch', '--list', 'feature'])).toContain('feature')
    if (marker === 'replacement') {
      expect(await readFile(lock, 'utf8')).toBe('manual failed lock\n')
    }
  }
)

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

it.each(['expiry', 'pool reset'])('preserves a replacement marker during %s', async (kind) => {
  const { root, repo } = await fixture()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    await startPreparation({
      repoPath: repo,
      workspaceRoot: root,
      baseBranch: 'main',
      canonicalBase: 'refs/heads/main',
      options: {}
    })
    const entry = listPreparations()[0]
    const lock = await git(entry.preparedPath, ['rev-parse', '--git-path', 'locked'])
    await writeFile(lock, 'manual expired lock\n')
    if (kind === 'expiry') {
      await vi.advanceTimersByTimeAsync(WORKTREE_CREATE_PREPARATION_TTL_MS)
    }
    await _resetPreparationPoolForTests()
    expect(await readFile(lock, 'utf8')).toBe('manual expired lock\n')
    expect(await readFile(join(entry.preparedPath, 'tracked.txt'), 'utf8')).toBe('original\n')
  } finally {
    vi.useRealTimers()
  }
})
