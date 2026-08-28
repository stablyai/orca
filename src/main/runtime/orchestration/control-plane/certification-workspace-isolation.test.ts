import { mkdirSync, mkdtempSync, symlinkSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  assertDisposableCertificationWorkspace,
  assessLeaseCoverage,
  isSameWorkspace,
  worktreePathOf
} from './certification-workspace-isolation'

function workspace(root: string, name: string, repoId = 'repo_a'): string {
  const path = join(root, name)
  mkdirSync(path, { recursive: true })
  return `${repoId}::${path}`
}

describe('certification workspace isolation', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-cert-iso-')))

  it('NEGATIVE CONTROL: refuses the source-worktree collision that caused the incident', () => {
    // Two certification workers were dispatched into the Package B implementation
    // worktree and committed to its branch. This is that exact placement.
    const implementation = workspace(root, 'jb-workflow-control-plane-b')
    expect(() =>
      assertDisposableCertificationWorkspace({
        intentWorktreeId: implementation,
        coordinatorWorktreeId: implementation
      })
    ).toThrowError(/certification worker cannot run in/)
  })

  it('refuses when the same directory is reached through a second repo registration', () => {
    const path = workspace(root, 'dual-registered')
    expect(() =>
      assertDisposableCertificationWorkspace({
        intentWorktreeId: path.replace('repo_a::', 'repo_b::'),
        coordinatorWorktreeId: path
      })
    ).toThrow(/certification worker cannot run in/)
  })

  it('refuses when a symlink spells the coordinator checkout a different way', () => {
    const real = workspace(root, 'real-checkout')
    const link = join(root, 'linked-checkout')
    symlinkSync(worktreePathOf(real), link)
    expect(() =>
      assertDisposableCertificationWorkspace({
        intentWorktreeId: `repo_a::${link}`,
        coordinatorWorktreeId: real
      })
    ).toThrow(/certification worker cannot run in/)
  })

  it('refuses a workspace nested inside the coordinator checkout', () => {
    const outer = workspace(root, 'outer')
    const inner = workspace(root, join('outer', 'nested'))
    expect(() =>
      assertDisposableCertificationWorkspace({
        intentWorktreeId: inner,
        coordinatorWorktreeId: outer
      })
    ).toThrow(/certification worker cannot run in/)
  })

  it('FAILS CLOSED when the coordinator placement cannot be established', () => {
    // Previously this returned, which let an unproven placement launch — the
    // same class of hole as the collision itself.
    expect(() =>
      assertDisposableCertificationWorkspace({
        intentWorktreeId: workspace(root, 'disposable-a'),
        coordinatorWorktreeId: null
      })
    ).toThrow(/cannot establish which workspace this coordinator occupies/)
  })

  it('FAILS CLOSED when either path does not exist on disk', () => {
    const real = workspace(root, 'disposable-b')
    expect(() =>
      assertDisposableCertificationWorkspace({
        intentWorktreeId: `repo_a::${join(root, 'never-created')}`,
        coordinatorWorktreeId: real
      })
    ).toThrow(/cannot resolve/)
    expect(() =>
      assertDisposableCertificationWorkspace({
        intentWorktreeId: real,
        coordinatorWorktreeId: `repo_a::${join(root, 'also-never-created')}`
      })
    ).toThrow(/cannot resolve the coordinator's own workspace/)
  })

  it('admits a genuinely disjoint disposable workspace', () => {
    expect(() =>
      assertDisposableCertificationWorkspace({
        intentWorktreeId: workspace(root, 'disposable-c'),
        coordinatorWorktreeId: workspace(root, 'implementation-c')
      })
    ).not.toThrow()
  })

  it('treats an unresolvable pair as the same workspace rather than as different', () => {
    expect(isSameWorkspace('repo_a::/nope/one', 'repo_a::/nope/two')).toBe(true)
  })
})

describe('what a validation lease can actually fence', () => {
  const canBlockClaude = (agent: string): boolean => agent === 'claude'

  it('NEGATIVE CONTROL: a route with no pre-tool deny channel is not covered', () => {
    // A lease over a worker Orca cannot stop before it mutates is a lease in
    // name only. Reporting that as protection is the same error as reading loss
    // of contact as process death.
    const coverage = assessLeaseCoverage(
      [
        { dispatchId: 'ctx_live', status: 'dispatched', terminalHandle: 't1', agent: 'codex' },
        { dispatchId: 'ctx_done', status: 'completed', terminalHandle: 't2', agent: 'codex' }
      ],
      canBlockClaude
    )
    expect(coverage.covered).toBe(false)
    expect(coverage.unfencedOccupants.map((row) => row.dispatchId)).toEqual(['ctx_live'])
    expect(coverage.reason).toMatch(/no synchronous pre-tool deny channel/)
    expect(coverage.remedies).toContain('use_isolated_worktree')
    expect(coverage.remedies).toContain('wait_for_lease_completion')
  })

  it('covers a live worker on a route that CAN be stopped before it mutates', () => {
    const coverage = assessLeaseCoverage(
      [{ dispatchId: 'ctx_live', status: 'dispatched', terminalHandle: 't1', agent: 'claude' }],
      canBlockClaude
    )
    expect(coverage).toMatchObject({ covered: true, unfencedOccupants: [], remedies: [] })
  })

  it('treats an unknown agent as unblockable rather than assuming it is fine', () => {
    expect(
      assessLeaseCoverage(
        [{ dispatchId: 'ctx_live', status: 'dispatched', terminalHandle: 't1', agent: null }],
        canBlockClaude
      ).covered
    ).toBe(false)
  })

  it('defaults to nothing being blockable when no capability is supplied', () => {
    expect(
      assessLeaseCoverage([
        { dispatchId: 'ctx_live', status: 'dispatched', terminalHandle: 't1', agent: 'claude' }
      ]).covered
    ).toBe(false)
  })

  it('reports full coverage when no worker is running', () => {
    expect(assessLeaseCoverage([]).covered).toBe(true)
  })
})
