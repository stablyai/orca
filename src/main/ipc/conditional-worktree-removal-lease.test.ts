import { describe, it, expect } from 'vitest'
import {
  beginConditionalWorktreePathUse,
  beginConditionalWorktreeUse,
  tryAcquireConditionalWorktreeRemoval,
  ConditionalWorktreeRemovalInProgressError
} from './conditional-worktree-removal-lease'
import { beginTerminalInstall } from './watcher-removal-gate'

describe('conditional worktree removal lease', () => {
  it('refuses a prior use without cancelling it, then fences every later use until release', async () => {
    const finish = beginConditionalWorktreeUse('repo::/conditional/prior')
    expect(tryAcquireConditionalWorktreeRemoval('/conditional/prior')).toEqual({ kind: 'busy' })
    finish()
    const lease = tryAcquireConditionalWorktreeRemoval('/conditional/prior')
    if (lease.kind !== 'acquired') {
      throw new Error('expected lease')
    }
    await Promise.resolve()
    expect(() => beginConditionalWorktreeUse('repo::/conditional/prior')).toThrow(
      ConditionalWorktreeRemovalInProgressError
    )
    expect(() => beginTerminalInstall('/conditional/prior/subdir')).toThrow(
      ConditionalWorktreeRemovalInProgressError
    )
    expect(() => beginConditionalWorktreePathUse('/conditional/prior')).toThrow(
      ConditionalWorktreeRemovalInProgressError
    )
    lease.release()
    lease.release()
    const next = beginConditionalWorktreeUse('repo::/conditional/prior')
    next()
  })

  it('does not confuse equal paths on different execution hosts', () => {
    const finish = beginConditionalWorktreeUse('repo::/conditional/hosts', 'ssh:other')
    const lease = tryAcquireConditionalWorktreeRemoval('/conditional/hosts')
    if (lease.kind !== 'acquired') {
      throw new Error('expected lease')
    }
    lease.release()
    finish()
  })
})

it('fences a symlink alias for both earlier and later operations', async () => {
  const { mkdtemp, mkdir, symlink, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const scratch = await mkdtemp(join(tmpdir(), 'orca-idle-alias-'))
  const target = join(scratch, 'target'),
    alias = join(scratch, 'alias')
  await mkdir(target)
  await symlink(target, alias, 'junction')
  try {
    const prior = beginConditionalWorktreePathUse(alias)
    expect(tryAcquireConditionalWorktreeRemoval(target)).toEqual({ kind: 'busy' })
    prior()
    const lease = tryAcquireConditionalWorktreeRemoval(target)
    if (lease.kind !== 'acquired') {
      throw new Error('expected lease')
    }
    try {
      expect(() => beginConditionalWorktreePathUse(alias)).toThrow(
        ConditionalWorktreeRemovalInProgressError
      )
      expect(() => beginTerminalInstall(join(alias, 'not-created-yet'))).toThrow(
        ConditionalWorktreeRemovalInProgressError
      )
    } finally {
      lease.release()
    }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
})
