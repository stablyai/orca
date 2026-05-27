import { describe, expect, it, vi } from 'vitest'
import {
  branchHasUpstream,
  renameCurrentBranch,
  resolveUniqueBranchName,
  type GitExec
} from './branch-rename'

const noUpstreamError = new Error(
  "fatal: no upstream configured for branch 'feature'\n" +
    'To push the current branch and set the remote as upstream, use\n' +
    '    git push --set-upstream origin feature'
)

describe('branchHasUpstream', () => {
  it('is true when @{u} resolves to a tracking ref', async () => {
    const exec: GitExec = vi.fn().mockResolvedValue({ stdout: 'origin/feature\n', stderr: '' })
    expect(await branchHasUpstream(exec)).toBe(true)
  })

  it('is false when there is no upstream', async () => {
    const exec: GitExec = vi.fn().mockRejectedValue(noUpstreamError)
    expect(await branchHasUpstream(exec)).toBe(false)
  })

  it('is conservatively true on an unexpected failure', async () => {
    const exec: GitExec = vi.fn().mockRejectedValue(new Error('fatal: not a git repository'))
    expect(await branchHasUpstream(exec)).toBe(true)
  })
})

describe('resolveUniqueBranchName', () => {
  const compute = (leaf: string): string => `you/${leaf}`

  it('returns the first candidate when no branch collides', async () => {
    const exec: GitExec = vi.fn().mockRejectedValue(new Error('not found')) // show-ref misses
    const result = await resolveUniqueBranchName(exec, 'fix-auth', compute, 'you/Nautilus')
    expect(result).toBe('you/fix-auth')
  })

  it('suffixes when the first candidate already exists', async () => {
    const exec: GitExec = vi.fn(async (args: string[]) => {
      const ref = args.at(-1)
      if (ref === 'refs/heads/you/fix-auth') {
        return { stdout: '', stderr: '' } // exists
      }
      throw new Error('not found')
    })
    const result = await resolveUniqueBranchName(exec, 'fix-auth', compute, 'you/Nautilus')
    expect(result).toBe('you/fix-auth-2')
  })

  it('does not treat the branch being renamed away from as a collision', async () => {
    // exec would report every ref as existing; only the currentBranch shortcut
    // lets a candidate through.
    const exec: GitExec = vi.fn().mockResolvedValue({ stdout: '', stderr: '' })
    const result = await resolveUniqueBranchName(exec, 'octopus', compute, 'you/octopus')
    expect(result).toBe('you/octopus')
  })
})

describe('renameCurrentBranch', () => {
  it('runs git branch -m with the new name', async () => {
    const exec: GitExec = vi.fn().mockResolvedValue({ stdout: '', stderr: '' })
    await renameCurrentBranch(exec, 'you/fix-auth')
    expect(exec).toHaveBeenCalledWith(['branch', '-m', 'you/fix-auth'])
  })
})
