import { describe, expect, it } from 'vitest'
import { SshPtyRecoveryRetentionBudget } from './ssh-pty-recovery-retention-budget'

describe('SshPtyRecoveryRetentionBudget', () => {
  it('bounds fragmented recovery by per-PTY and session source, charged bytes, and frames', () => {
    const budget = new SshPtyRecoveryRetentionBudget({
      perPtySourceSu: 4,
      perPtyBytes: 300,
      perPtyFrames: 2,
      sessionSourceSu: 6,
      sessionBytes: 500,
      sessionFrames: 3
    })

    expect(budget.tryRetain('pty-1', 'aa', 2)).toBe(true)
    expect(budget.tryRetain('pty-1', 'bb', 2)).toBe(true)
    expect(budget.tryRetain('pty-1', 'c', 0)).toBe(false)
    expect(budget.tryRetain('pty-2', 'cc', 2)).toBe(true)
    expect(budget.snapshot()).toEqual({ sourceSu: 6, bytes: 396, frames: 3, ptys: 2 })
    expect(budget.tryRetain('pty-2', 'd', 1)).toBe(false)

    budget.release('pty-1')

    expect(budget.snapshot()).toEqual({ sourceSu: 2, bytes: 132, frames: 1, ptys: 1 })
    expect(budget.tryRetain('pty-2', 'dd', 2)).toBe(true)
  })

  it('charges UTF-16 storage plus one record before aggregate admission', () => {
    const budget = new SshPtyRecoveryRetentionBudget({
      perPtySourceSu: 100,
      perPtyBytes: 1_000,
      perPtyFrames: 10,
      sessionSourceSu: 100,
      sessionBytes: 500,
      sessionFrames: 10
    })

    expect(budget.tryRetain('pty-1', '\u0000'.repeat(64), 1)).toBe(true)
    expect(budget.snapshot().bytes).toBe(256)
    expect(budget.tryRetain('pty-2', '\u0000'.repeat(64), 1)).toBe(false)
    expect(budget.snapshot()).toEqual({ sourceSu: 1, bytes: 256, frames: 1, ptys: 1 })
  })
})
