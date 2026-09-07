import { describe, expect, it, vi } from 'vitest'
import type { GitExecFn } from './fork-remote-refspec'
import {
  fetchForkRemoteWithStaleRefspecRepair,
  parseMissingForkBranchRef
} from './fork-remote-stale-branch-refspec'

describe('parseMissingForkBranchRef', () => {
  it('extracts the missing ref from a "couldn\'t find remote ref" fatal', () => {
    expect(parseMissingForkBranchRef("fatal: couldn't find remote ref refs/heads/gone\n")).toBe(
      'refs/heads/gone'
    )
  })

  it('returns null for unrelated stderr', () => {
    expect(parseMissingForkBranchRef('fatal: Authentication failed\n')).toBeNull()
  })
})

function makeExec(getAllStdout: string): GitExecFn {
  return vi.fn<GitExecFn>(async (args: string[]) => {
    if (args[1] === '--get-all') {
      return { stdout: getAllStdout, stderr: '' }
    }
    return { stdout: '', stderr: '' }
  })
}

describe('fetchForkRemoteWithStaleRefspecRepair', () => {
  it('retries once after dropping a stale refspec, and returns on success', async () => {
    const exec = makeExec(
      '+refs/heads/gone:refs/remotes/fork/gone\n+refs/heads/keep:refs/remotes/fork/keep\n'
    )
    let attempts = 0
    const runFetch = vi.fn(async () => {
      attempts += 1
      if (attempts === 1) {
        throw Object.assign(new Error('boom'), {
          stderr: "fatal: couldn't find remote ref refs/heads/gone\n"
        })
      }
    })

    await fetchForkRemoteWithStaleRefspecRepair(exec, '/repo', 'fork', runFetch)

    expect(runFetch).toHaveBeenCalledTimes(2)
  })

  it('rethrows immediately when the error is not a stale-refspec failure', async () => {
    const exec = makeExec('+refs/heads/keep:refs/remotes/fork/keep\n')
    const runFetch = vi.fn(async () => {
      throw new Error('network unreachable')
    })

    await expect(
      fetchForkRemoteWithStaleRefspecRepair(exec, '/repo', 'fork', runFetch)
    ).rejects.toThrow('network unreachable')
    expect(runFetch).toHaveBeenCalledTimes(1)
  })

  it('rethrows when the reported stale ref is not actually a tracked refspec (fail safe, no infinite loop)', async () => {
    const exec = makeExec('+refs/heads/keep:refs/remotes/fork/keep\n')
    const runFetch = vi.fn(async () => {
      throw Object.assign(new Error('boom'), {
        stderr: "fatal: couldn't find remote ref refs/heads/not-tracked\n"
      })
    })

    await expect(
      fetchForkRemoteWithStaleRefspecRepair(exec, '/repo', 'fork', runFetch)
    ).rejects.toThrow('boom')
    expect(runFetch).toHaveBeenCalledTimes(1)
  })

  it('resolves multiple stale refspecs across repeated attempts', async () => {
    let refspecs = [
      '+refs/heads/gone-a:refs/remotes/fork/gone-a',
      '+refs/heads/gone-b:refs/remotes/fork/gone-b',
      '+refs/heads/keep:refs/remotes/fork/keep'
    ]
    const exec = vi.fn<GitExecFn>(async (args: string[]) => {
      if (args[1] === '--get-all') {
        return { stdout: refspecs.length ? `${refspecs.join('\n')}\n` : '', stderr: '' }
      }
      if (args[1] === '--unset-all') {
        refspecs = []
        return { stdout: '', stderr: '' }
      }
      if (args[1] === '--add') {
        refspecs.push(args[3]!)
        return { stdout: '', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })
    // Why: mirrors real git reporting exactly one missing ref per fetch attempt (see #17828 PR).
    const staleBranches = ['refs/heads/gone-a', 'refs/heads/gone-b']
    const runFetch = vi.fn(async () => {
      const stillStale = staleBranches.find((branch) => refspecs.some((r) => r.includes(branch)))
      if (stillStale) {
        throw Object.assign(new Error('boom'), {
          stderr: `fatal: couldn't find remote ref ${stillStale}\n`
        })
      }
    })

    await fetchForkRemoteWithStaleRefspecRepair(exec, '/repo', 'fork', runFetch)

    expect(runFetch).toHaveBeenCalledTimes(3)
    expect(refspecs).toEqual(['+refs/heads/keep:refs/remotes/fork/keep'])
  })
})
