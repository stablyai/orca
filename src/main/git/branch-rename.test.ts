import { describe, expect, it, vi } from 'vitest'
import {
  probeBranchUpstream,
  renameCurrentBranch,
  resolveUniqueBranchName,
  type GitExec
} from './branch-rename'

const noUpstreamError = new Error(
  "fatal: no upstream configured for branch 'feature'\n" +
    'To push the current branch and set the remote as upstream, use\n' +
    '    git push --set-upstream origin feature'
)

describe('probeBranchUpstream', () => {
  it('reports has-upstream when @{u} resolves to a tracking ref', async () => {
    const exec: GitExec = vi.fn(async (args: string[]) => {
      if (args[0] === 'symbolic-ref') {
        return { stdout: 'feature\n', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args.includes('HEAD@{u}')) {
        return { stdout: 'origin/feature\n', stderr: '' }
      }
      throw new Error(`unexpected git args: ${args.join(' ')}`)
    })
    expect(await probeBranchUpstream(exec)).toEqual({ outcome: 'has-upstream' })
  })

  it('reports no-upstream when there is no upstream', async () => {
    const exec: GitExec = vi.fn(async (args: string[]) => {
      if (args[0] === 'symbolic-ref') {
        return { stdout: 'feature\n', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args.includes('HEAD@{u}')) {
        throw noUpstreamError
      }
      if (args[0] === 'rev-parse' && args.includes('refs/remotes/origin/feature')) {
        throw new Error('not found')
      }
      throw new Error(`unexpected git args: ${args.join(' ')}`)
    })
    expect(await probeBranchUpstream(exec)).toEqual({ outcome: 'no-upstream' })
  })

  it('reports has-upstream when a same-name origin tracking ref exists without configured upstream', async () => {
    const exec: GitExec = vi.fn(async (args: string[]) => {
      if (args[0] === 'symbolic-ref') {
        return { stdout: 'feature\n', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args.includes('HEAD@{u}')) {
        throw noUpstreamError
      }
      if (args[0] === 'rev-parse' && args.includes('refs/remotes/origin/feature')) {
        return { stdout: '', stderr: '' }
      }
      throw new Error(`unexpected git args: ${args.join(' ')}`)
    })
    expect(await probeBranchUpstream(exec)).toEqual({ outcome: 'has-upstream' })
  })

  it('reports probe-failed on an unexpected failure', async () => {
    const exec: GitExec = vi.fn().mockRejectedValue(new Error('fatal: not a git repository'))
    expect(await probeBranchUpstream(exec)).toEqual({
      outcome: 'probe-failed',
      message: 'fatal: not a git repository'
    })
  })

  it('scrubs credential-bearing URLs from the probe-failed message', async () => {
    // The message surfaces on the worktree card, so an embedded remote URL
    // must not leak a token or password into the UI.
    const exec: GitExec = vi
      .fn()
      .mockRejectedValue(
        new Error('fatal: unable to access https://user:hunter2@example.com/repo.git/: timed out')
      )
    expect(await probeBranchUpstream(exec)).toEqual({
      outcome: 'probe-failed',
      message: 'fatal: unable to access https://example.com/repo.git/: timed out'
    })
  })

  it('reports probe-failed, not has-upstream, for localized git diagnostics (issue #7808)', async () => {
    // A gettext-enabled git under de_DE translates even the `fatal:` prefix.
    const exec: GitExec = vi.fn(async (args: string[]) => {
      if (args[0] === 'symbolic-ref') {
        return { stdout: 'feature\n', stderr: '' }
      }
      throw new Error(
        'Command failed: git rev-parse --abbrev-ref HEAD@{u}\n' +
          "Schwerwiegend: Kein Upstream-Branch für Branch 'feature' konfiguriert."
      )
    })
    const probe = await probeBranchUpstream(exec)
    expect(probe.outcome).toBe('probe-failed')
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
