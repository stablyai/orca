import { describe, expect, it } from 'vitest'
import { quoteShellToken } from '../shared/ephemeral-vm-recipe-process'
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
      `If terminal term_worker is still residual after the outcome is settled: orca terminal close --terminal ${quoteShellToken(
        'term_worker'
      )} --json.`
    )
    expect(lines[1]).toBe(
      `If worktree repo::child is still residual after the outcome is settled: orca worktree rm --worktree ${quoteShellToken(
        'id:repo::child'
      )} --force --json (verify nothing valuable was written first).`
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

  it('quotes ids shell-safely so copied commands survive spaces and metacharacters', () => {
    const lines = residualResourceRecoveryLines([
      { kind: 'worktree', id: 'repo::D:/workspaces/my work/child; rm -rf /' },
      { kind: 'terminal', id: "term_ev" + "'" + "il" }
    ])

    // The displayed name stays raw; the pasted command quotes the id (posix
    // single-quoting off win32, cmd.exe double-quoting on it).
    if (process.platform !== 'win32') {
      expect(lines[0]).toContain(
        "orca worktree rm --worktree " + "'" + "id:repo::D:/workspaces/my work/child; rm -rf /" + "'" + " --force --json"
      )
      expect(lines[1]).toContain(
        "orca terminal close --terminal " + "'" + "term_ev" + "'\\''" + "il" + "'" + " --json"
      )
    } else {
      expect(lines[0]).toContain('--worktree "id:repo::D:/workspaces/my work/child; rm -rf /"')
      expect(lines[1]).toContain('--terminal "term_ev' + "'" + 'il"')
    }
  })

  it('returns nothing for absent or non-array residue', () => {
    expect(residualResourceRecoveryLines(undefined)).toEqual([])
    expect(residualResourceRecoveryLines(null)).toEqual([])
    expect(residualResourceRecoveryLines('terminal')).toEqual([])
    expect(residualResourceRecoveryLines({})).toEqual([])
  })
})
