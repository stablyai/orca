import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeWorktreePsSummary } from '../../shared/runtime-worktree-contracts'

const runtimes = vi.hoisted(() => {
  const state: { list: unknown[]; reads: number; fail: boolean } = {
    list: [],
    reads: 0,
    fail: false
  }
  return state
})
vi.mock('../../shared/ephemeral-vm-runtime-store', () => ({
  listEphemeralVmRuntimes: () => {
    runtimes.reads += 1
    if (runtimes.fail) {
      throw new Error('unreadable')
    }
    return runtimes.list
  }
}))

import { notifyEphemeralVmRuntimesChanged } from '../../shared/ephemeral-vm-runtime-store-events'
import {
  cloudWorkspaceStatusById,
  markCloudWorkspaceRows,
  resetCloudWorkspaceStatusCache
} from './cloud-workspace-ps-status'

const cloud = (workspaceId: string, status: string, createdAt = 0) => ({
  recipe: { provider: 'orca-cloud' },
  workspaceId,
  status,
  createdAt
})

describe('cloudWorkspaceStatusById', () => {
  beforeEach(() => {
    runtimes.list = []
    runtimes.reads = 0
    runtimes.fail = false
  })
  afterEach(() => resetCloudWorkspaceStatusCache())

  it('lists only Orca Cloud workspaces, and a cleaned VM never hides a live one', () => {
    // Newest first, as the store keeps it: wt-c's newer cleaned VM must not hide its live one, and
    // wt-d, with only a cleaned VM, is still a cloud workspace (as on the desktop).
    runtimes.list = [
      cloud('wt-a', 'running', 300),
      { recipe: { provider: 'other' }, workspaceId: 'wt-b', status: 'running', createdAt: 300 },
      cloud('wt-c', 'cleaned', 200),
      cloud('wt-c', 'suspended', 100),
      cloud('wt-d', 'cleaned', 100)
    ]
    expect([...cloudWorkspaceStatusById('/u', 0)]).toEqual([
      ['wt-a', 'running'],
      ['wt-c', 'suspended'],
      ['wt-d', 'cleaned']
    ])
  })

  it('speaks for a workspace with its newest VM, wherever that record sits in the file', () => {
    runtimes.list = [cloud('wt-a', 'running', 200), cloud('wt-a', 'failed', 100)]
    expect(cloudWorkspaceStatusById('/u', 0).get('wt-a')).toBe('running')
    resetCloudWorkspaceStatusCache()
    runtimes.list = [cloud('wt-a', 'failed', 100), cloud('wt-a', 'suspended', 200)]
    expect(cloudWorkspaceStatusById('/u', 0).get('wt-a')).toBe('suspended')
  })

  it('reads the store once until it changes or the cache ages out', () => {
    runtimes.list = [cloud('wt-a', 'running')]
    cloudWorkspaceStatusById('/u', 0)
    cloudWorkspaceStatusById('/u', 1_000)
    expect(runtimes.reads).toBe(1)
    runtimes.list = [cloud('wt-a', 'suspended')]
    notifyEphemeralVmRuntimesChanged()
    expect(cloudWorkspaceStatusById('/u', 2_000).get('wt-a')).toBe('suspended')
    expect(runtimes.reads).toBe(2)
    cloudWorkspaceStatusById('/u', 20_000)
    expect(runtimes.reads).toBe(3)
  })

  it('marks nothing when the store is unreadable', () => {
    runtimes.fail = true
    expect(cloudWorkspaceStatusById('/u', 0).size).toBe(0)
  })
})

describe('markCloudWorkspaceRows', () => {
  it('sets orcaCloud on cloud rows only', () => {
    const rows: Pick<RuntimeWorktreePsSummary, 'worktreeId' | 'orcaCloud'>[] = [
      { worktreeId: 'wt-a' },
      { worktreeId: 'wt-b' }
    ]
    markCloudWorkspaceRows(rows, new Map([['wt-a', 'suspended' as const]]))
    expect(rows[0].orcaCloud).toEqual({ status: 'suspended' })
    expect(rows[1].orcaCloud).toBeUndefined()
  })
})
