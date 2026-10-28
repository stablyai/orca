import { describe, it, expect } from 'vitest'
import { WorkspaceViewers } from '../runtime/sidebar-inputs/workspace-viewers'
import { tryAcquireConditionalWorktreeRemoval } from './conditional-worktree-removal-lease'

const workspace = 'repo::/presence/checkout'
describe('conditional removal and user presence', () => {
  it('does not delete behind an older client whose active workspace is unknown', () => {
    const viewers = new WorkspaceViewers(Date.now)
    viewers.noteSelfRaisingClient('legacy')
    expect(tryAcquireConditionalWorktreeRemoval('/presence/checkout')).toEqual({ kind: 'busy' })
    viewers.dropClient('legacy')
    const lease = tryAcquireConditionalWorktreeRemoval('/presence/checkout')
    if (lease.kind !== 'acquired') {
      throw new Error('expected lease')
    }
    expect(() => viewers.noteSelfRaisingClient('new-legacy')).toThrow('removal is in progress')
    expect(() =>
      viewers.reportClientView('new-client', {
        workspaceIds: [workspace],
        tabIds: [],
        presentForMs: null
      })
    ).toThrow('removal is in progress')
    expect(viewers.isViewing(workspace, null)).toBe(false)
    lease.release()
  })

  it('holds a phone session through its actual connection lifetime', () => {
    const viewers = new WorkspaceViewers(Date.now)
    const close = viewers.openPhoneSession(workspace)
    expect(tryAcquireConditionalWorktreeRemoval('/presence/checkout')).toEqual({ kind: 'busy' })
    close()
    close()
    const lease = tryAcquireConditionalWorktreeRemoval('/presence/checkout')
    if (lease.kind !== 'acquired') {
      throw new Error('expected lease')
    }
    lease.release()
  })
})

it('retains a symlink viewer until replacement, expiry or connection drop', async () => {
  const { mkdtemp, mkdir, realpath, symlink, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orca-view-presence-alias-')))
  const target = join(root, 'target'),
    alias = join(root, 'alias')
  await mkdir(target)
  await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir')
  let now = 100
  const viewers = new WorkspaceViewers(() => now)
  const assertIdle = () => {
    const lease = tryAcquireConditionalWorktreeRemoval(target)
    if (lease.kind !== 'acquired') {
      throw new Error('expected idle checkout')
    }
    lease.release()
  }
  try {
    viewers.reportClientView('desktop', {
      workspaceIds: [`repo::${alias}`],
      tabIds: [],
      presentForMs: null
    })
    expect(tryAcquireConditionalWorktreeRemoval(target)).toEqual({ kind: 'busy' })
    viewers.reportClientView('desktop', { workspaceIds: [], tabIds: [], presentForMs: null })
    assertIdle()
    viewers.reportClientView('desktop', {
      workspaceIds: [`repo::${alias}`],
      tabIds: [],
      presentForMs: 100
    })
    now = 199
    expect(tryAcquireConditionalWorktreeRemoval(target)).toEqual({ kind: 'busy' })
    now = 200
    assertIdle()
    viewers.reportClientView('desktop', {
      workspaceIds: [`repo::${alias}`],
      tabIds: [],
      presentForMs: null
    })
    viewers.dropClient('desktop')
    assertIdle()
  } finally {
    viewers.dropClient('desktop')
    await rm(root, { recursive: true, force: true })
  }
})
