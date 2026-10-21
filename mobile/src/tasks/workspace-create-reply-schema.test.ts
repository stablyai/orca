import { describe, expect, it } from 'vitest'
import {
  agentLaunchCreateReceiptSchema,
  worktreeCreateReceiptSchema,
  worktreeHostedBaseSchema
} from './workspace-create-reply-schema'

// Pins the one requirement on a create receipt, the arm order of the hosted-base union, and the
// two paths that must stay reachable: an empty worktree id and an empty soft-error message.

describe('the worktree create receipt', () => {
  it('reads every recorded create', () => {
    for (const result of [
      { worktree: { id: 'wt-1', displayName: 'ORC-1 Recorded issue' } },
      { worktree: { id: 'wt-2' }, warning: 'shallow clone' },
      { worktree: { id: 'repo-1::/w' }, warning: '  startup terminal failed  ' }
    ]) {
      expect(worktreeCreateReceiptSchema.safeParse(result)).toMatchObject({ success: true })
    }
  })

  it('keeps the warning untrimmed, because both readers trim it themselves', () => {
    const parsed = worktreeCreateReceiptSchema.safeParse({
      worktree: { id: 'w' },
      warning: '  startup terminal failed  '
    })
    expect(parsed.success && parsed.data).toMatchObject({ warning: '  startup terminal failed  ' })
  })

  it('leaves the empty-id arm reachable rather than making it a decode failure', () => {
    const parsed = worktreeCreateReceiptSchema.safeParse({ worktree: { id: '' } })
    expect(parsed.success && parsed.data).toMatchObject({ worktree: { id: '' } })
  })

  it('names a receipt with no worktree record, which routed the phone to /session/undefined', () => {
    expect(worktreeCreateReceiptSchema.safeParse({ warning: 'x' }).success).toBe(false)
    expect(worktreeCreateReceiptSchema.safeParse({ worktree: {} }).success).toBe(false)
    expect(worktreeCreateReceiptSchema.safeParse(null).success).toBe(false)
  })
})

describe('the agent.launch receipt', () => {
  it('reads the recorded structured receipt whole', () => {
    const result = {
      outcome: { kind: 'structured', sessionId: 'sess-1', handle: 't-1' },
      worktreeId: 'repo-1::/w',
      warning: '  startup terminal failed  ',
      receipt: {
        mode: 'structured',
        preferred: 'structured',
        reason: 'user_default',
        detail: 'Structured session created.'
      }
    }
    expect(agentLaunchCreateReceiptSchema.safeParse(result)).toMatchObject({
      success: true,
      data: result
    })
  })

  it('requires nothing under the container, because the reader guards every member', () => {
    expect(agentLaunchCreateReceiptSchema.safeParse({}).success).toBe(true)
  })

  it('names a receipt that is not an object at all', () => {
    for (const result of [null, 'launched', 7, true]) {
      expect(agentLaunchCreateReceiptSchema.safeParse(result).success).toBe(false)
    }
  })
})

describe('the hosted base resolvers', () => {
  it('reads both recorded successes', () => {
    expect(worktreeHostedBaseSchema.safeParse({ baseBranch: 'main' }).success).toBe(true)
    expect(
      worktreeHostedBaseSchema.safeParse({ baseBranch: 'main', compareBaseRef: 'origin/main' })
        .success
    ).toBe(true)
  })

  it('takes the error arm first, so a soft failure is never read as a base branch', () => {
    const parsed = worktreeHostedBaseSchema.safeParse({
      error: 'pull request not found',
      baseBranch: 'main'
    })
    expect(parsed.success && parsed.data).toMatchObject({ error: 'pull request not found' })
  })

  it('keeps an empty soft-error message, which the create replaces with its own copy', () => {
    const parsed = worktreeHostedBaseSchema.safeParse({ error: '' })
    expect(parsed.success && parsed.data).toMatchObject({ error: '' })
  })

  it('forwards the rest of a start point the create spreads into its params', () => {
    const parsed = worktreeHostedBaseSchema.safeParse({
      baseBranch: 'main',
      pushTarget: { kind: 'fork', remote: 'origin' },
      branchNameOverride: 'pr-12',
      maintainerCanModify: false
    })
    expect(parsed.success && parsed.data).toMatchObject({
      pushTarget: { kind: 'fork', remote: 'origin' },
      branchNameOverride: 'pr-12',
      maintainerCanModify: false
    })
  })

  it('names a reply that is neither arm, where `in` was a TypeError', () => {
    expect(worktreeHostedBaseSchema.safeParse({}).success).toBe(false)
    expect(worktreeHostedBaseSchema.safeParse('main').success).toBe(false)
    expect(worktreeHostedBaseSchema.safeParse(null).success).toBe(false)
  })
})
