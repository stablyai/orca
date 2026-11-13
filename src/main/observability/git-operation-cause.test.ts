import { afterEach, expect, it } from 'vitest'
import { runWithGitCause } from './git-operation-cause'
import { startGitSpan, withGitSpan } from './instrumentation'
import { setActiveSink } from './tracer'

afterEach(() => setActiveSink(null))

it('keeps concurrent Git causes isolated and retires a settled cause before detached work', async () => {
  const records: unknown[] = []
  setActiveSink({ push: (record) => records.push(record), flush() {}, close() {} })
  const firstGate = Promise.withResolvers<void>()
  const secondGate = Promise.withResolvers<void>()
  const detachedGate = Promise.withResolvers<void>()
  let detached = Promise.resolve()
  const first = runWithGitCause(
    { family: 'catalog', reason: 'desktop-catalog', cache: 'miss' },
    { namespace: 'local', commonDir: '/fixture/common.git' },
    async () => {
      detached = detachedGate.promise.then(() =>
        withGitSpan({ args: ['worktree', 'remove', 'PRIVATE_PATH'] }, async () => {})
      )
      await withGitSpan({ args: ['worktree', 'list', '--porcelain', '-z'] }, async () => {
        await firstGate.promise
      })
    }
  )
  const second = runWithGitCause(
    { family: 'fetch', reason: 'conflict-preview', cache: 'refresh' },
    { namespace: 'wsl:fixture', commonDir: '/fixture/common.git' },
    () => withGitSpan({ args: ['fetch', 'PRIVATE_REMOTE'] }, () => secondGate.promise)
  )
  secondGate.resolve()
  await second
  firstGate.resolve()
  await first
  detachedGate.resolve()
  await detached

  expect(records).toEqual([
    expect.objectContaining({
      attributes: expect.objectContaining({
        'git.reason': 'conflict-preview',
        'git.cache': 'refresh',
        'git.common_dir_hash': '48e43725147afff2'
      })
    }),
    expect.objectContaining({
      attributes: expect.objectContaining({
        'git.reason': 'desktop-catalog',
        'git.variant': 'worktree-list-z',
        'git.common_dir_hash': '39be98da86a94d54'
      })
    }),
    expect.objectContaining({
      attributes: expect.objectContaining({
        'git.subcommand': 'worktree',
        'git.arg_count': 3,
        'git.variant': 'worktree-remove'
      })
    })
  ])
  expect(records[2]).toEqual(
    expect.objectContaining({
      attributes: expect.not.objectContaining({ 'git.reason': expect.any(String) })
    })
  )
  expect(JSON.stringify(records)).not.toContain('PRIVATE_')
})

it('records fixed failure categories without changing the original Git rejection', async () => {
  const records: unknown[] = []
  setActiveSink({ push: (record) => records.push(record), flush() {}, close() {} })
  const error = new Error('PRIVATE_OUTPUT')
  await expect(
    withGitSpan({ args: ['for-each-ref', '--sort=-committerdate', 'PRIVATE_QUERY'] }, async () => {
      throw error
    })
  ).rejects.toBe(error)
  const timeout = new Error('PRIVATE_TIMEOUT')
  timeout.name = 'GitCommandTimeoutError'
  startGitSpan({ args: ['fetch', 'PRIVATE_REMOTE'] }).fail(timeout)
  const cancelled = new Error('PRIVATE_CANCEL')
  cancelled.name = 'AbortError'
  startGitSpan({ args: ['status'] }).fail(cancelled)
  startGitSpan({ args: ['status'] }).interrupt('PRIVATE_INTERRUPT')

  expect(records).toEqual([
    expect.objectContaining({ exit: { _tag: 'Failure', cause: 'Git command failed' } }),
    expect.objectContaining({ exit: { _tag: 'Failure', cause: 'Git command timed out' } }),
    expect.objectContaining({ exit: { _tag: 'Failure', cause: 'Git command cancelled' } }),
    expect.objectContaining({ exit: { _tag: 'Interrupted', cause: 'Git command cancelled' } })
  ])
  expect(JSON.stringify(records)).not.toContain('PRIVATE_')
})
