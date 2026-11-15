import { fixture, git, removeLifetimeFixtures } from './worktree-preparation-lifetime.test-fixture'

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

import * as gitRunner from '../../../git/command-runner/git-exec-file'

import { _resetWorktreeCreatePreparationsForTests } from './worktree-create-preparation'

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()

  await _resetWorktreeCreatePreparationsForTests()
  await removeLifetimeFixtures()
})

it('parks an unproven writer and autonomously removes its hidden checkout after late proof', async () => {
  const { root, arm, create } = await fixture()
  const failed = Promise.withResolvers<void>()
  const started = Promise.withResolvers<void>()
  const terminated = Promise.withResolvers<void>()
  const waiting = Promise.withResolvers<void>()
  const run = gitRunner.gitExecFileAsync
  let preparedPath = ''
  vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args, options) => {
    if (args.includes('reset') && !preparedPath) {
      preparedPath = options.cwd
      options.observeChildTermination?.(terminated.promise, true)
      started.resolve()
      await failed.promise
      throw new Error('writer result rejected before termination proof')
    }
    return run(args, options)
  })
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  const preparation = arm().catch(() => {})
  await started.promise
  const creation = create('writer-fallback', 'main', {}, waiting.resolve)
  await waiting.promise
  failed.resolve()
  await creation
  await preparation
  await vi.advanceTimersByTimeAsync(30_000)
  expect(existsSync(join(preparedPath, '.git'))).toBe(true)
  // Repeated requests cannot revive or wait again on the same parked writer.
  await arm()
  await arm()
  terminated.resolve()
  await vi.waitFor(() => expect(existsSync(preparedPath)).toBe(false))
  await create('after-writer')
  expect(await readFile(join(root, 'writer-fallback', 'version.txt'), 'utf8')).toBe('original\n')
  expect(git(root, '-C', join(root, 'repo'), 'worktree', 'list', '--porcelain')).not.toContain(
    preparedPath
  )
})
