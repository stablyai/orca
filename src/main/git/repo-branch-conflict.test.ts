import { describe, expect, it, vi } from 'vitest'

import { getBranchConflictKindViaExec } from './repo-branch-conflict'

describe('getBranchConflictKindViaExec', () => {
  it('probes exact configured remote refs instead of enumerating the remote namespace', async () => {
    const calls: string[][] = []
    const exec = async (argv: string[]): Promise<{ stdout: string }> => {
      calls.push(argv)
      if (argv[0] === 'for-each-ref') {
        return { stdout: '' }
      }
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
      ['rev-parse', '--verify', '--quiet', 'refs/heads/feature/fix'],
      ['for-each-ref', '--format=%(refname)', 'refs/heads/'],
      ['remote'],
      ['show-ref', '--verify', '--quiet', '--', 'refs/remotes/foo/bar/feature/fix'],
      ['show-ref', '--verify', '--quiet', '--', 'refs/remotes/origin/feature/fix']
    ])
  })

  it('does not run a ref query when the only candidate is the allowed base', async () => {
    const calls: string[][] = []
    const exec = async (argv: string[]): Promise<{ stdout: string }> => {
      calls.push(argv)
      if (argv[0] === 'for-each-ref') {
        return { stdout: '' }
      }
      if (argv[0] === 'remote') {
        return { stdout: 'origin\n' }
      }
      throw new Error('the local branch and remote ref are absent')
    }

    await expect(
      getBranchConflictKindViaExec(exec, 'feature/fix', 'origin/feature/fix')
    ).resolves.toBeNull()
    expect(calls).toEqual([
      ['rev-parse', '--verify', '--quiet', 'refs/heads/feature/fix'],
      ['for-each-ref', '--format=%(refname)', 'refs/heads/'],
      ['remote']
    ])
  })

  it('keeps longest configured remote-name matching semantics', async () => {
    const calls: string[][] = []
    const exec = async (argv: string[]): Promise<{ stdout: string }> => {
      calls.push(argv)
      if (argv[0] === 'for-each-ref') {
        return { stdout: '' }
      }
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
      if (argv[0] === 'for-each-ref') {
        return { stdout: '' }
      }
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
      if (argv[0] === 'for-each-ref') {
        return { stdout: '' }
      }
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

describe('getBranchConflictKindViaExec batched remote probe', () => {
  function remoteNames(count: number): string {
    return `${Array.from({ length: count }, (_, index) => `remote${index}`).join('\n')}\n`
  }

  function baseExec(calls: string[][]): (argv: string[]) => Promise<{ stdout: string }> {
    return async (argv) => {
      calls.push(argv)
      if (argv[0] === 'for-each-ref') {
        return { stdout: '' }
      }
      if (argv[0] === 'rev-parse') {
        throw new Error('local branch is absent')
      }
      if (argv[0] === 'remote') {
        return { stdout: remoteNames(3) }
      }
      throw new Error(`unexpected git command: ${argv.join(' ')}`)
    }
  }

  it('asks one batched child instead of one probe per remote', async () => {
    const calls: string[][] = []
    const stdinPayloads: (string | undefined)[] = []
    const exec = baseExec(calls)
    const batched = async (
      argv: string[],
      options: { stdin: string }
    ): Promise<{ stdout: string }> => {
      calls.push(argv)
      stdinPayloads.push(options.stdin)
      return {
        stdout: [
          'refs/remotes/remote0/feature missing',
          'refs/remotes/remote1/feature missing',
          'refs/remotes/remote2/feature missing'
        ].join('\n')
      }
    }

    await expect(
      getBranchConflictKindViaExec(exec, 'feature', undefined, {}, batched)
    ).resolves.toBeNull()
    expect(calls).toEqual([
      ['rev-parse', '--verify', '--quiet', 'refs/heads/feature'],
      ['for-each-ref', '--format=%(refname)', 'refs/heads/'],
      ['remote'],
      ['cat-file', '--batch-check']
    ])
    expect(stdinPayloads).toEqual([
      'refs/remotes/remote0/feature\nrefs/remotes/remote1/feature\nrefs/remotes/remote2/feature\n'
    ])
  })

  it('reports a remote conflict from the batched answer', async () => {
    const calls: string[][] = []
    const exec = baseExec(calls)
    const batched = async (): Promise<{ stdout: string }> => ({
      stdout: [
        'refs/remotes/remote0/feature missing',
        `${'a'.repeat(40)} commit 214`,
        'refs/remotes/remote2/feature missing'
      ].join('\n')
    })

    await expect(
      getBranchConflictKindViaExec(exec, 'feature', undefined, {}, batched)
    ).resolves.toBe('remote')
  })

  it('falls back to per-ref probes when the batch cannot answer', async () => {
    const calls: string[][] = []
    const exec = async (argv: string[]): Promise<{ stdout: string }> => {
      calls.push(argv)
      if (argv[0] === 'for-each-ref') {
        return { stdout: '' }
      }
      if (argv[0] === 'rev-parse') {
        throw new Error('local branch is absent')
      }
      if (argv[0] === 'remote') {
        return { stdout: remoteNames(3) }
      }
      if (argv[0] === 'show-ref') {
        if (argv[4] === 'refs/remotes/remote1/feature') {
          return { stdout: 'abc refs/remotes/remote1/feature\n' }
        }
        throw Object.assign(new Error('missing'), { code: 1, stderr: '' })
      }
      throw new Error(`unexpected git command: ${argv.join(' ')}`)
    }
    const batched = async (): Promise<{ stdout: string }> => {
      throw new Error('cat-file is unavailable')
    }

    await expect(
      getBranchConflictKindViaExec(exec, 'feature', undefined, {}, batched)
    ).resolves.toBe('remote')
    expect(calls.filter((argv) => argv[0] === 'show-ref')).toHaveLength(3)
  })

  it('treats a short batch read as undecided rather than as absence', async () => {
    const calls: string[][] = []
    const exec = async (argv: string[]): Promise<{ stdout: string }> => {
      calls.push(argv)
      if (argv[0] === 'for-each-ref') {
        return { stdout: '' }
      }
      if (argv[0] === 'rev-parse') {
        throw new Error('local branch is absent')
      }
      if (argv[0] === 'remote') {
        return { stdout: remoteNames(3) }
      }
      if (argv[0] === 'show-ref') {
        throw Object.assign(new Error('missing'), { code: 1, stderr: '' })
      }
      throw new Error(`unexpected git command: ${argv.join(' ')}`)
    }
    const batched = async (): Promise<{ stdout: string }> => ({
      stdout: 'refs/remotes/remote0/feature missing'
    })

    await expect(
      getBranchConflictKindViaExec(exec, 'feature', undefined, {}, batched)
    ).resolves.toBeNull()
    expect(calls.filter((argv) => argv[0] === 'show-ref')).toHaveLength(3)
  })
})

describe('branch conflict with existing-branch adoption', () => {
  const absent = () => Object.assign(new Error('missing'), { code: 1, stderr: '' })

  it('skips adoption and its commit probe for a proven missing local ref', async () => {
    const exec = vi.fn(async (argv: string[]) => {
      if (argv[0] === 'for-each-ref') {
        return { stdout: '' }
      }
      if (argv[0] === 'rev-parse') {
        throw absent()
      }
      return { stdout: '' }
    })
    const adopt = vi.fn(async () => false)
    await expect(
      getBranchConflictKindViaExec(exec, 'new', undefined, {}, undefined, adopt)
    ).resolves.toBeNull()
    expect(adopt).not.toHaveBeenCalled()
    expect(exec).toHaveBeenCalledTimes(3)
  })

  it('allows an existing branch without querying remote refs', async () => {
    const exec = vi.fn(async () => ({ stdout: 'a'.repeat(40) }))
    const adopt = vi.fn(async () => true)
    await expect(
      getBranchConflictKindViaExec(exec, 'existing', undefined, {}, undefined, adopt)
    ).resolves.toBeNull()
    expect(adopt).toHaveBeenCalledOnce()
    expect(exec).toHaveBeenCalledOnce()
  })

  it('retains conflicts for refs whose objects cannot be adopted as commits', async () => {
    const exec = vi.fn(async () => ({ stdout: 'a'.repeat(40) }))
    const adopt = vi.fn(async () => false)
    await expect(
      getBranchConflictKindViaExec(exec, 'dangling', undefined, {}, undefined, adopt)
    ).resolves.toBe('local')
    expect(adopt).toHaveBeenCalledOnce()
    expect(exec).toHaveBeenCalledTimes(2)
  })

  it.each([
    Object.assign(new Error('transport'), { code: 1, stderr: 'transport failed' }),
    Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })
  ])('still attempts adoption after an undecided ref probe: %s', async (error) => {
    const exec = vi.fn(async () => {
      throw error
    })
    const adopt = vi.fn(async () => true)
    await expect(
      getBranchConflictKindViaExec(exec, 'existing', undefined, {}, undefined, adopt)
    ).resolves.toBeNull()
    expect(adopt).toHaveBeenCalledOnce()
  })

  it('rechecks a ref that disappeared while adoption was running', async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce({ stdout: 'a'.repeat(40) })
      .mockRejectedValueOnce(absent())
      .mockResolvedValueOnce({ stdout: '' })
      .mockResolvedValueOnce({ stdout: '' })
    await expect(
      getBranchConflictKindViaExec(exec, 'removed', undefined, {}, undefined, async () => false)
    ).resolves.toBeNull()
    expect(exec).toHaveBeenCalledTimes(4)
  })
})

describe('portable branch-name conflicts', () => {
  function executor(refs = '') {
    return vi.fn(async (argv: string[]) => {
      if (argv[0] === 'rev-parse') {
        throw Object.assign(new Error('missing'), { code: 1, stderr: '' })
      }
      return { stdout: argv[0] === 'for-each-ref' ? refs : '' }
    })
  }

  it.each([
    ['feature', 'Feature'],
    ['Ä', 'ä'],
    ['K', 'K'],
    ['ß', 'ẞ'],
    ['ẞ', 'ß'],
    ['ς', 'Σ'],
    ['ﬃ', 'FFI'],
    ['𐐀', '𐐨'],
    ['é', 'e\u0301'],
    ['feature/Ä', 'FEATURE/ä']
  ])('rejects packed ref aliases %s → %s without a config probe', async (existing, candidate) => {
    const exec = executor(`refs/heads/${existing}\n`)
    const adopt = vi.fn(async () => false)
    await expect(
      getBranchConflictKindViaExec(exec, candidate, undefined, {}, undefined, adopt)
    ).resolves.toBe('local')
    expect(adopt).not.toHaveBeenCalled()
    expect(exec.mock.calls.map(([argv]) => argv)).toEqual([
      ['rev-parse', '--verify', '--quiet', `refs/heads/${candidate}`],
      ['for-each-ref', '--format=%(refname)', 'refs/heads/']
    ])
  })

  it('does not confuse descendants or similarly named branches with aliases', async () => {
    const exec = executor('refs/heads/feature/child\nrefs/heads/feature-other\n')
    await expect(getBranchConflictKindViaExec(exec, 'Feature')).resolves.toBeNull()
  })

  it.each([
    Object.assign(new Error('SSH disconnected'), { code: 1, stderr: 'transport failed' }),
    Object.assign(new Error('output exceeded cap'), { code: 'ENOBUFS' })
  ])('fails closed when the bounded host listing fails: %s', async (error) => {
    const exec = executor()
    exec.mockImplementationOnce(async () => {
      throw Object.assign(new Error('missing'), { code: 1, stderr: '' })
    })
    exec.mockImplementationOnce(async () => {
      throw error
    })
    await expect(getBranchConflictKindViaExec(exec, 'Feature')).rejects.toThrow(error.message)
    expect(exec.mock.calls.some(([argv]) => argv[0] === 'remote')).toBe(false)
  })

  it('fails closed on unexpected stdout instead of treating it as an empty listing', async () => {
    const exec = executor('Welcome to the host\n')
    await expect(getBranchConflictKindViaExec(exec, 'Feature')).rejects.toThrow(
      'Cannot verify branch-name case conflicts'
    )
  })

  it('forwards the host output and timeout bounds to the local branch listing', async () => {
    const exec = executor()
    await getBranchConflictKindViaExec(exec, 'new-feature', undefined, {
      maxBuffer: 1024,
      timeoutMs: 100
    })
    expect(exec).toHaveBeenCalledWith(['for-each-ref', '--format=%(refname)', 'refs/heads/'], {
      maxBuffer: 1024,
      timeoutMs: 100
    })
  })
})
