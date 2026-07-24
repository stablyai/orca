import { beforeEach, describe, expect, it } from 'vitest'
import {
  BRANCH_RENAME_FAILURE_KEY_MAX_BYTES,
  BRANCH_RENAME_FAILURE_OUTPUT_MAX_BYTES,
  __getBranchRenameFailureOutputCountForTests,
  __resetBranchRenameFailureOutputForTests,
  readBranchRenameFailureOutputForDisplay,
  rememberBranchRenameFailureOutput
} from './branch-rename-failure-output'

const output = (label: string) => ({
  label,
  exitCode: 1,
  stdout: '',
  stderr: `${label} failed`
})

beforeEach(() => {
  __resetBranchRenameFailureOutputForTests()
})

describe('branch rename failure output store', () => {
  it('returns the formatted capture for a remembered worktree', () => {
    rememberBranchRenameFailureOutput('wt-1', output('Pi'))
    expect(readBranchRenameFailureOutputForDisplay('wt-1')).toBe(
      'Pi exited with code 1.\n\n[stderr]\nPi failed'
    )
  })

  it('returns null for unknown worktrees and after clearing', () => {
    expect(readBranchRenameFailureOutputForDisplay('wt-unknown')).toBeNull()
    rememberBranchRenameFailureOutput('wt-1', output('Pi'))
    rememberBranchRenameFailureOutput('wt-1', null)
    expect(readBranchRenameFailureOutputForDisplay('wt-1')).toBeNull()
  })

  it('evicts the least recently recorded worktree beyond the cap', () => {
    for (let index = 0; index < 33; index += 1) {
      rememberBranchRenameFailureOutput(`wt-${index}`, output(`Agent${index}`))
    }
    expect(readBranchRenameFailureOutputForDisplay('wt-0')).toBeNull()
    expect(readBranchRenameFailureOutputForDisplay('wt-32')).not.toBeNull()
  })

  it('re-recording refreshes recency so the entry survives eviction', () => {
    for (let index = 0; index < 32; index += 1) {
      rememberBranchRenameFailureOutput(`wt-${index}`, output(`Agent${index}`))
    }
    rememberBranchRenameFailureOutput('wt-0', output('Agent0-again'))
    rememberBranchRenameFailureOutput('wt-new', output('AgentNew'))
    expect(readBranchRenameFailureOutputForDisplay('wt-0')).not.toBeNull()
    expect(readBranchRenameFailureOutputForDisplay('wt-1')).toBeNull()
  })

  it('admits exact byte boundaries and skips oversized retained text', () => {
    const exactKey = 'k'.repeat(BRANCH_RENAME_FAILURE_KEY_MAX_BYTES)
    const oversizedKey = `${exactKey}x`
    rememberBranchRenameFailureOutput(exactKey, {
      label: '',
      exitCode: 1,
      stdout: 'x'.repeat(BRANCH_RENAME_FAILURE_OUTPUT_MAX_BYTES),
      stderr: ''
    })
    rememberBranchRenameFailureOutput(oversizedKey, output('oversized-key'))
    rememberBranchRenameFailureOutput('oversized-output', {
      label: '',
      exitCode: 1,
      stdout: 'x'.repeat(BRANCH_RENAME_FAILURE_OUTPUT_MAX_BYTES + 1),
      stderr: ''
    })

    expect(__getBranchRenameFailureOutputCountForTests()).toBe(1)
    expect(readBranchRenameFailureOutputForDisplay(exactKey)).not.toBeNull()
    expect(readBranchRenameFailureOutputForDisplay(oversizedKey)).toBeNull()
    expect(readBranchRenameFailureOutputForDisplay('oversized-output')).toBeNull()
  })
})
