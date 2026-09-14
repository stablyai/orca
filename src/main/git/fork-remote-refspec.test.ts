import { describe, expect, it, vi, type Mock } from 'vitest'
import {
  buildNarrowForkFetchRefspec,
  ensureRemoteTracksBranchNarrowly,
  getRemoteFetchRefspecs,
  pruneUntrackedForkRemoteRefs,
  removeStaleForkFetchRefspec,
  wildcardForkFetchRefspec,
  type GitExecFn
} from './fork-remote-refspec'

type ExecMock = Mock<GitExecFn>

const REPO = '/repo-root'

// In-memory `remote.<name>.fetch`/`.tagOpt` config, mutated the way real `git config` would be.
function makeConfigExec(fetchByRemote: Record<string, string[]> = {}): {
  exec: ExecMock
  tagOptByRemote: Record<string, string>
} {
  const tagOptByRemote: Record<string, string> = {}
  const exec = vi.fn<GitExecFn>(async (args: string[]) => {
    const key = args[2]
    if (args[0] === 'config' && args[1] === '--get-all' && key?.endsWith('.fetch')) {
      const remoteName = key.slice('remote.'.length, -'.fetch'.length)
      const values = fetchByRemote[remoteName] ?? []
      if (values.length === 0) {
        throw new Error('key not found')
      }
      return { stdout: `${values.join('\n')}\n`, stderr: '' }
    }
    if (args[0] === 'config' && args[1] === '--unset-all' && key?.endsWith('.fetch')) {
      const remoteName = key.slice('remote.'.length, -'.fetch'.length)
      fetchByRemote[remoteName] = []
      return { stdout: '', stderr: '' }
    }
    if (args[0] === 'config' && args[1] === '--add' && key?.endsWith('.fetch')) {
      const remoteName = key.slice('remote.'.length, -'.fetch'.length)
      fetchByRemote[remoteName] = [...(fetchByRemote[remoteName] ?? []), args[3]!]
      return { stdout: '', stderr: '' }
    }
    if (args[0] === 'config' && args[1]?.endsWith('.tagOpt')) {
      const remoteName = args[1].slice('remote.'.length, -'.tagOpt'.length)
      tagOptByRemote[remoteName] = args[2]!
      return { stdout: '', stderr: '' }
    }
    return { stdout: '', stderr: '' }
  })
  return { exec, tagOptByRemote }
}

describe('buildNarrowForkFetchRefspec / wildcardForkFetchRefspec', () => {
  it('builds the narrow (trailing-* suffixed) and wide refspec shapes', () => {
    expect(buildNarrowForkFetchRefspec('fork', 'feature/fix')).toBe(
      '+refs/heads/feature/fix*:refs/remotes/fork/feature/fix*'
    )
    expect(wildcardForkFetchRefspec('fork')).toBe('+refs/heads/*:refs/remotes/fork/*')
  })
})

describe('getRemoteFetchRefspecs', () => {
  it('returns [] when the remote has no configured refspec', async () => {
    const { exec } = makeConfigExec()
    await expect(getRemoteFetchRefspecs(exec, REPO, 'fork')).resolves.toEqual([])
  })

  it('returns every configured refspec', async () => {
    const { exec } = makeConfigExec({
      fork: ['+refs/heads/a:refs/remotes/fork/a', '+refs/heads/b:refs/remotes/fork/b']
    })
    await expect(getRemoteFetchRefspecs(exec, REPO, 'fork')).resolves.toEqual([
      '+refs/heads/a:refs/remotes/fork/a',
      '+refs/heads/b:refs/remotes/fork/b'
    ])
  })
})

describe('ensureRemoteTracksBranchNarrowly', () => {
  it('replaces the wide default refspec with a single trailing-* narrow one', async () => {
    const { exec, tagOptByRemote } = makeConfigExec({ fork: [wildcardForkFetchRefspec('fork')] })

    await ensureRemoteTracksBranchNarrowly(exec, REPO, 'fork', 'main')

    await expect(getRemoteFetchRefspecs(exec, REPO, 'fork')).resolves.toEqual([
      '+refs/heads/main*:refs/remotes/fork/main*'
    ])
    expect(tagOptByRemote.fork).toBe('--no-tags')
  })

  it('adds a second branch alongside an already-narrow one instead of replacing it', async () => {
    const { exec } = makeConfigExec({ fork: ['+refs/heads/main*:refs/remotes/fork/main*'] })

    await ensureRemoteTracksBranchNarrowly(exec, REPO, 'fork', 'feature')

    await expect(getRemoteFetchRefspecs(exec, REPO, 'fork')).resolves.toEqual([
      '+refs/heads/main*:refs/remotes/fork/main*',
      '+refs/heads/feature*:refs/remotes/fork/feature*'
    ])
  })

  it('is a no-op for a branch already narrowly tracked (idempotent)', async () => {
    const { exec } = makeConfigExec({ fork: ['+refs/heads/main*:refs/remotes/fork/main*'] })

    await ensureRemoteTracksBranchNarrowly(exec, REPO, 'fork', 'main')

    const addCalls = exec.mock.calls.filter(([args]) => args[1] === '--add')
    expect(addCalls).toEqual([])
  })

  it('replaces a stray literal (non-suffixed) entry for the same branch with the suffixed form', async () => {
    const { exec } = makeConfigExec({ fork: ['+refs/heads/main:refs/remotes/fork/main'] })

    await ensureRemoteTracksBranchNarrowly(exec, REPO, 'fork', 'main')

    await expect(getRemoteFetchRefspecs(exec, REPO, 'fork')).resolves.toEqual([
      '+refs/heads/main*:refs/remotes/fork/main*'
    ])
  })

  it('leaves a different branch entry untouched when replacing a stray literal', async () => {
    const { exec } = makeConfigExec({
      fork: [
        '+refs/heads/main:refs/remotes/fork/main',
        '+refs/heads/other*:refs/remotes/fork/other*'
      ]
    })

    await ensureRemoteTracksBranchNarrowly(exec, REPO, 'fork', 'main')

    await expect(getRemoteFetchRefspecs(exec, REPO, 'fork')).resolves.toEqual([
      '+refs/heads/other*:refs/remotes/fork/other*',
      '+refs/heads/main*:refs/remotes/fork/main*'
    ])
  })
})

describe('removeStaleForkFetchRefspec', () => {
  it('drops only the refspec whose source matches the stale branch', async () => {
    const { exec } = makeConfigExec({
      fork: ['+refs/heads/gone:refs/remotes/fork/gone', '+refs/heads/keep:refs/remotes/fork/keep']
    })

    await expect(removeStaleForkFetchRefspec(exec, REPO, 'fork', 'gone')).resolves.toBe(true)
    await expect(getRemoteFetchRefspecs(exec, REPO, 'fork')).resolves.toEqual([
      '+refs/heads/keep:refs/remotes/fork/keep'
    ])
  })

  it('returns false and changes nothing when the branch is not tracked', async () => {
    const { exec } = makeConfigExec({ fork: ['+refs/heads/keep:refs/remotes/fork/keep'] })

    await expect(removeStaleForkFetchRefspec(exec, REPO, 'fork', 'gone')).resolves.toBe(false)
    await expect(getRemoteFetchRefspecs(exec, REPO, 'fork')).resolves.toEqual([
      '+refs/heads/keep:refs/remotes/fork/keep'
    ])
  })
})

describe('pruneUntrackedForkRemoteRefs', () => {
  function makeRefsExec(refs: string[]): { exec: Mock<GitExecFn>; refs: string[] } {
    const state = [...refs]
    const exec = vi.fn<GitExecFn>(async (args: string[]) => {
      if (args[0] === 'for-each-ref') {
        const prefix = args[2]!
        return {
          stdout: state.map((r) => `${prefix}${r}`).join('\n') + (state.length ? '\n' : ''),
          stderr: ''
        }
      }
      if (args[0] === 'update-ref' && args[1] === '-d') {
        const refname = args[2]!
        const idx = state.findIndex((r) => refname.endsWith(`/${r}`))
        if (idx !== -1) {
          state.splice(idx, 1)
        }
        return { stdout: '', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })
    return { exec, refs: state }
  }

  it('deletes tracking refs outside the keep set and leaves the rest', async () => {
    const { exec, refs } = makeRefsExec(['main', 'unrelated-1', 'unrelated-2'])

    const deleted = await pruneUntrackedForkRemoteRefs(exec, REPO, 'fork', new Set(['main']))

    expect(deleted.sort()).toEqual(
      ['refs/remotes/fork/unrelated-1', 'refs/remotes/fork/unrelated-2'].sort()
    )
    expect(refs).toEqual(['main'])
  })

  it('never deletes HEAD even if not in the keep set', async () => {
    const { exec, refs } = makeRefsExec(['HEAD', 'main'])

    await pruneUntrackedForkRemoteRefs(exec, REPO, 'fork', new Set(['main']))

    expect(refs).toEqual(['HEAD', 'main'])
  })

  it('is a no-op when nothing is stray', async () => {
    const { exec, refs } = makeRefsExec(['main'])

    const deleted = await pruneUntrackedForkRemoteRefs(exec, REPO, 'fork', new Set(['main']))

    expect(deleted).toEqual([])
    expect(refs).toEqual(['main'])
  })

  it("keeps a ref that shares a branch prefix, matching the refspec's own trailing-* match", async () => {
    const { exec, refs } = makeRefsExec(['fix', 'fix-extra', 'unrelated'])

    const deleted = await pruneUntrackedForkRemoteRefs(exec, REPO, 'fork', new Set(['fix']))

    expect(deleted).toEqual(['refs/remotes/fork/unrelated'])
    expect(refs.sort()).toEqual(['fix', 'fix-extra'])
  })
})
