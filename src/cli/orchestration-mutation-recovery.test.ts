import { describe, expect, it } from 'vitest'
import { residualResourceRecoveryLines } from './orchestration-mutation-recovery'

describe('residualResourceRecoveryLines', () => {
  // Why (#15944): the receipt used to name residual resources without any action for them,
  // and the orchestration guide ends at "inspect" — the reclaim command must ride along.
  it('maps terminal and worktree residue to their reclaim commands', () => {
    const lines = residualResourceRecoveryLines([
      { kind: 'terminal', role: 'agent', id: 'term_worker', surface: 'visible' },
      { kind: 'worktree', action: 'created_child', id: 'repo::child' }
    ])

    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe(
      'If terminal term_worker is still residual after the outcome is settled: orca terminal close --terminal term_worker --json.'
    )
    expect(lines[1]).toBe(
      'If worktree repo::child is still residual after the outcome is settled: orca worktree rm --worktree id:repo::child --force --json (verify nothing valuable was written first).'
    )
  })

  it('skips resources without an id and kinds it cannot advise on', () => {
    expect(
      residualResourceRecoveryLines([
        { kind: 'terminal' },
        { kind: 'setup', id: 'term_setup' },
        { id: 'term_orphan' },
        null
      ])
    ).toEqual([])
  })

  it('returns nothing for absent or non-array residue', () => {
    expect(residualResourceRecoveryLines(undefined)).toEqual([])
    expect(residualResourceRecoveryLines(null)).toEqual([])
    expect(residualResourceRecoveryLines('terminal')).toEqual([])
    expect(residualResourceRecoveryLines({})).toEqual([])
  })
})
