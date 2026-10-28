import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { tryAcquireConditionalWorktreeRemoval } from './conditional-worktree-removal-lease'
import { withConditionalWorktreeUses } from './conditional-worktree-operation'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-operation-admission-'))
})
afterEach(() => rm(root, { recursive: true, force: true }))
const target = () => ({ workspaceId: `repo::${root}`, hostId: 'local' })
function assertIdle(): void {
  const admission = tryAcquireConditionalWorktreeRemoval(root)
  if (admission.kind !== 'acquired') {
    throw new Error('Expected idle operation scope')
  }
  admission.release()
}

it('holds admitted work until its promise settles', async () => {
  let finish: ((value: number) => void) | undefined
  const result = withConditionalWorktreeUses(
    [target()],
    () =>
      new Promise<number>((resolve) => {
        finish = resolve
      })
  )
  expect(tryAcquireConditionalWorktreeRemoval(root)).toEqual({ kind: 'busy' })
  finish?.(1)
  await expect(result).resolves.toBe(1)
  assertIdle()
})

it('releases after synchronous and asynchronous failures', async () => {
  expect(() =>
    withConditionalWorktreeUses([target()], () => {
      throw new Error('synchronous failure')
    })
  ).toThrow('synchronous failure')
  assertIdle()
  await expect(
    withConditionalWorktreeUses([target()], async () => {
      throw new Error('asynchronous failure')
    })
  ).rejects.toThrow('asynchronous failure')
  assertIdle()
})

it('refuses new operations before invoking their callback', () => {
  const admission = tryAcquireConditionalWorktreeRemoval(root)
  if (admission.kind !== 'acquired') {
    throw new Error('Expected closing scope')
  }
  const run = vi.fn(async () => 1)
  try {
    expect(() => withConditionalWorktreeUses([target()], run)).toThrow('removal is in progress')
    expect(run).not.toHaveBeenCalled()
  } finally {
    admission.release()
  }
})

it('unwinds earlier scopes if a later acquisition is refused', () => {
  const admission = tryAcquireConditionalWorktreeRemoval(join(root, 'closing'))
  if (admission.kind !== 'acquired') {
    throw new Error('Expected closing scope')
  }
  const run = vi.fn(async () => 1)
  try {
    expect(() =>
      withConditionalWorktreeUses(
        [
          { workspaceId: `repo::${join(root, 'other')}`, hostId: 'local' },
          { workspaceId: `repo::${join(root, 'closing')}`, hostId: 'local' }
        ],
        run
      )
    ).toThrow('removal is in progress')
    expect(run).not.toHaveBeenCalled()
  } finally {
    admission.release()
  }
  assertIdle()
})
