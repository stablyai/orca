import { describe, expect, it } from 'vitest'
import { cloudWorktreeRowStatus } from './cloud-worktree-row'

describe('cloudWorktreeRowStatus', () => {
  it('is null for a row that is not an Orca Cloud workspace', () => {
    expect(cloudWorktreeRowStatus(undefined)).toBeNull()
    expect(cloudWorktreeRowStatus(null)).toBeNull()
    expect(cloudWorktreeRowStatus('running')).toBeNull()
    expect(cloudWorktreeRowStatus({})).toBeNull()
  })

  it("maps the desktop's VM states to the phone's", () => {
    expect(cloudWorktreeRowStatus({ status: 'provisioning' })).toEqual({ status: 'creating' })
    expect(cloudWorktreeRowStatus({ status: 'running' })).toEqual({ status: 'running' })
    expect(cloudWorktreeRowStatus({ status: 'suspend_failed' })).toEqual({ status: 'running' })
    expect(cloudWorktreeRowStatus({ status: 'suspended' })).toEqual({ status: 'sleeping' })
    expect(cloudWorktreeRowStatus({ status: 'resume_failed' })).toEqual({ status: 'failed' })
    expect(cloudWorktreeRowStatus({ status: 'cleanup_pending' })).toEqual({ status: 'deleting' })
  })

  it("keeps the row cloud but drops the state for a word this build doesn't know", () => {
    expect(cloudWorktreeRowStatus({ status: 'hibernating' })).toEqual({ status: null })
    expect(cloudWorktreeRowStatus({ status: 3 })).toEqual({ status: null })
    expect(cloudWorktreeRowStatus({ status: 'cleanup_failed' })).toEqual({ status: null })
    expect(cloudWorktreeRowStatus({ status: 'cleaned' })).toEqual({ status: null })
  })
})
