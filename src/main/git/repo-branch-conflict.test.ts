import { describe, expect, it, vi } from 'vitest'

import { getBranchConflictKindViaExec } from './repo-branch-conflict'

describe('getBranchConflictKindViaExec', () => {
  it('probes exact configured remote refs instead of enumerating the remote namespace', async () => {
    const calls: string[][] = []
    const exec = async (argv: string[]): Promise<{ stdout: string }> => {
      calls.push(argv)
      if (argv[0] === 'rev-parse') {
        throw new Error('local branch is absent')
      }
      if (argv[0] === 'remote') {
        return { stdout: 'origin\nfoo/bar\n' }
      }
      if (argv[0] === 'show-ref') {
        return { stdout: 'abc refs/remotes/foo/bar/feature/fix\n' }
      }
      throw new Error(`unexpected git command: ${argv.join(' ')}`)
    }

    await expect(getBranchConflictKindViaExec(exec, 'feature/fix')).resolves.toBe('remote')
    expect(calls).toEqual([
      ['rev-parse', '--verify', 'refs/heads/feature/fix'],
      ['remote'],
      ['show-ref', '--verify', '--quiet', '--', 'refs/remotes/foo/bar/feature/fix'],
      ['show-ref', '--verify', '--quiet', '--', 'refs/remotes/origin/feature/fix']
    ])
  })

  it('does not run a ref query when the only candidate is the allowed base', async () => {
    const calls: string[][] = []
    const exec = async (argv: string[]): Promise<{ stdout: string }> => {
      calls.push(argv)
      if (argv[0] === 'remote') {
        return { stdout: 'origin\n' }
      }
      throw new Error('the local branch and remote ref are absent')
    }

    await expect(
      getBranchConflictKindViaExec(exec, 'feature/fix', 'origin/feature/fix')
    ).resolves.toBeNull()
    expect(calls).toEqual([['rev-parse', '--verify', 'refs/heads/feature/fix'], ['remote']])
  })

  it('keeps longest configured remote-name matching semantics', async () => {
    const calls: string[][] = []
    const exec = async (argv: string[]): Promise<{ stdout: string }> => {
      calls.push(argv)
      if (argv[0] === 'rev-parse') {
        throw new Error('local branch is absent')
      }
      if (argv[0] === 'remote') {
        return { stdout: 'foo\nfoo/bar\n' }
      }
      if (argv[0] === 'show-ref') {
        return { stdout: 'abc refs/remotes/foo/bar/bar/feature\n' }
      }
      throw new Error(`unexpected git command: ${argv.join(' ')}`)
    }

    await expect(getBranchConflictKindViaExec(exec, 'bar/feature')).resolves.toBe('remote')
    expect(calls.at(-1)).toEqual([
      'show-ref',
      '--verify',
      '--quiet',
      '--',
      'refs/remotes/foo/bar/bar/feature'
    ])
  })

  it('does not treat a nested branch ref as an exact conflict', async () => {
    const calls: string[][] = []
    const exec = async (argv: string[]): Promise<{ stdout: string }> => {
      calls.push(argv)
      if (argv[0] === 'rev-parse') {
        throw new Error('local branch is absent')
      }
      if (argv[0] === 'remote') {
        return { stdout: 'origin\n' }
      }
      if (argv[0] === 'show-ref') {
        // The exact ref is absent even though a descendant exists.
        throw new Error('missing exact ref')
      }
      throw new Error(`unexpected git command: ${argv.join(' ')}`)
    }

    await expect(getBranchConflictKindViaExec(exec, 'feature')).resolves.toBeNull()
    expect(calls.at(-1)).toEqual([
      'show-ref',
      '--verify',
      '--quiet',
      '--',
      'refs/remotes/origin/feature'
    ])
  })

  it('bounds concurrent exact probes when a repository has many remotes', async () => {
    const remoteNames = Array.from({ length: 12 }, (_, index) => `remote-${index}`)
    let probeCount = 0
    let activeProbes = 0
    let maxActiveProbes = 0
    const exec = async (argv: string[]): Promise<{ stdout: string }> => {
      if (argv[0] === 'rev-parse') {
        throw new Error('local branch is absent')
      }
      if (argv[0] === 'remote') {
        return { stdout: `${remoteNames.join('\n')}\n` }
      }
      if (argv[0] === 'show-ref') {
        probeCount += 1
        activeProbes += 1
        maxActiveProbes = Math.max(maxActiveProbes, activeProbes)
        await new Promise((resolve) => setTimeout(resolve, 0))
        activeProbes -= 1
        throw Object.assign(new Error('missing exact ref'), { code: 1 })
      }
      throw new Error(`unexpected git command: ${argv.join(' ')}`)
    }

    await expect(getBranchConflictKindViaExec(exec, 'feature')).resolves.toBeNull()
    expect(probeCount).toBe(12)
    // Equality, not a ceiling: 12 candidates saturate the pool, so a regression
    // to serial probing has to fail here.
    expect(maxActiveProbes).toBe(8)
  })

  it('does not turn an invalid branch name into a ref glob', async () => {
    const exec = vi.fn(async () => ({ stdout: '' }))

    await expect(getBranchConflictKindViaExec(exec, 'feature*')).resolves.toBeNull()
    expect(exec).not.toHaveBeenCalled()
  })
})
