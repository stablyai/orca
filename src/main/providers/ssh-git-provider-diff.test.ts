import { describe, expect, it, beforeEach } from 'vitest'
import { SshGitProvider } from './ssh-git-provider'
import {
  createMockMux,
  waitForRequestCount,
  type MockMultiplexer
} from './ssh-git-provider-test-harness'

function deferredValue<T>(value: T): { promise: Promise<T>; resolve: () => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve
  })
  return { promise, resolve: () => resolve(value) }
}

describe('SshGitProvider', () => {
  let mux: MockMultiplexer
  let provider: SshGitProvider

  beforeEach(() => {
    mux = createMockMux()
    provider = new SshGitProvider('conn-1', mux as never)
  })

  it('getDiff sends git.diff request', async () => {
    const diffResult = { kind: 'text', originalContent: '', modifiedContent: 'hello' }
    mux.request.mockResolvedValue(diffResult)

    const result = await provider.getDiff('/home/user/repo', 'src/index.ts', true)
    expect(mux.request).toHaveBeenCalledWith('git.diff', {
      worktreePath: '/home/user/repo',
      filePath: 'src/index.ts',
      staged: true,
      // Why: opts into response streaming; a small result still comes back as a
      // single frame (relay decides), and old relays ignore the flag.
      __streamResponse: true
    })
    expect(result).toEqual(diffResult)
  })

  it('getBranchDiff sends git.branchDiff request', async () => {
    const diffs = [{ kind: 'text', originalContent: '', modifiedContent: 'new' }]
    mux.request.mockResolvedValue(diffs)

    const result = await provider.getBranchDiff('/home/user/repo', 'main')
    expect(mux.request).toHaveBeenCalledWith('git.branchDiff', {
      worktreePath: '/home/user/repo',
      baseRef: 'main',
      __streamResponse: true
    })
    expect(result).toEqual(diffs)
  })

  it('getBranchDiff forwards a pinned head OID without adding it when omitted', async () => {
    const headOid = 'a'.repeat(40)
    mux.request.mockResolvedValue([])

    await provider.getBranchDiff('/home/user/repo', 'main', {
      includePatch: true,
      filePath: 'src/file.ts',
      headOid
    })
    await provider.getBranchDiff('/home/user/repo', 'main', {
      includePatch: true,
      filePath: 'src/other-file.ts',
      headOid: undefined
    })

    expect(mux.request).toHaveBeenNthCalledWith(1, 'git.branchDiff', {
      worktreePath: '/home/user/repo',
      baseRef: 'main',
      includePatch: true,
      filePath: 'src/file.ts',
      headOid,
      __streamResponse: true
    })
    expect(mux.request).toHaveBeenNthCalledWith(2, 'git.branchDiff', {
      worktreePath: '/home/user/repo',
      baseRef: 'main',
      includePatch: true,
      filePath: 'src/other-file.ts',
      __streamResponse: true
    })
  })

  // Why: an unpinned compare snapshot reaches getBranchDiff as null despite the type.
  it('omits a null head OID and shares the absent-head dedupe key', async () => {
    const diffs = [{ kind: 'text', originalContent: 'old', modifiedContent: 'new' }]
    const pendingDiff = deferredValue(diffs)
    const headOid = 'a'.repeat(40)
    mux.request.mockReturnValue(pendingDiff.promise)

    const reads = [
      provider.getBranchDiff('/home/user/repo', 'main', {
        includePatch: true,
        filePath: 'src/file.ts',
        headOid: null as unknown as undefined
      }),
      provider.getBranchDiff('/home/user/repo', 'main', {
        includePatch: true,
        filePath: 'src/file.ts'
      }),
      provider.getBranchDiff('/home/user/repo', 'main', {
        includePatch: true,
        filePath: 'src/file.ts',
        headOid
      })
    ]

    await waitForRequestCount(mux.request, 2)
    expect(mux.request).toHaveBeenCalledTimes(2)
    expect(mux.request).toHaveBeenNthCalledWith(1, 'git.branchDiff', {
      worktreePath: '/home/user/repo',
      baseRef: 'main',
      includePatch: true,
      filePath: 'src/file.ts',
      __streamResponse: true
    })
    expect(mux.request).toHaveBeenNthCalledWith(2, 'git.branchDiff', {
      worktreePath: '/home/user/repo',
      baseRef: 'main',
      includePatch: true,
      filePath: 'src/file.ts',
      headOid,
      __streamResponse: true
    })

    pendingDiff.resolve()
    await expect(Promise.all(reads)).resolves.toEqual(Array.from({ length: 3 }, () => diffs))
  })

  it('coalesces matching branch diff heads while keeping distinct and absent heads separate', async () => {
    const diffs = [{ kind: 'text', originalContent: 'old', modifiedContent: 'new' }]
    const pendingDiff = deferredValue(diffs)
    const firstHeadOid = 'a'.repeat(40)
    const secondHeadOid = 'b'.repeat(40)
    mux.request.mockReturnValue(pendingDiff.promise)

    const reads = [
      provider.getBranchDiff('/home/user/repo', 'main', {
        includePatch: true,
        filePath: 'src/file.ts',
        headOid: firstHeadOid
      }),
      provider.getBranchDiff('/home/user/repo', 'main', {
        filePath: 'src/file.ts',
        headOid: firstHeadOid,
        includePatch: true
      }),
      provider.getBranchDiff('/home/user/repo', 'main', {
        includePatch: true,
        filePath: 'src/file.ts',
        headOid: secondHeadOid
      }),
      provider.getBranchDiff('/home/user/repo', 'main', {
        includePatch: true,
        filePath: 'src/file.ts'
      }),
      provider.getBranchDiff('/home/user/repo', 'main', {
        includePatch: true,
        filePath: 'src/file.ts',
        headOid: undefined
      })
    ]

    await waitForRequestCount(mux.request, 3)
    expect(mux.request).toHaveBeenCalledTimes(3)

    pendingDiff.resolve()
    await expect(Promise.all(reads)).resolves.toEqual(Array.from({ length: 5 }, () => diffs))
  })

  it('coalesces concurrent identical diff RPCs while in flight', async () => {
    const diff = {
      kind: 'text',
      originalContent: 'old',
      modifiedContent: 'new',
      originalIsBinary: false,
      modifiedIsBinary: false
    }
    const pendingDiff = deferredValue(diff)
    mux.request.mockReturnValue(pendingDiff.promise)

    const reads = Array.from({ length: 8 }, () =>
      provider.getDiff('/home/user/repo', 'src/file.ts', false, true)
    )

    await waitForRequestCount(mux.request, 1)
    expect(mux.request).toHaveBeenCalledTimes(1)
    pendingDiff.resolve()

    await expect(Promise.all(reads)).resolves.toEqual(Array.from({ length: 8 }, () => diff))

    mux.request.mockReset()
    const branchDiffs = [diff]
    const pendingBranchDiff = deferredValue(branchDiffs)
    mux.request.mockReturnValue(pendingBranchDiff.promise)

    const branchReads = Array.from({ length: 8 }, () =>
      provider.getBranchDiff('/home/user/repo', 'main', {
        includePatch: true,
        filePath: 'src/file.ts'
      })
    )

    await waitForRequestCount(mux.request, 1)
    expect(mux.request).toHaveBeenCalledTimes(1)
    pendingBranchDiff.resolve()
    await expect(Promise.all(branchReads)).resolves.toEqual(
      Array.from({ length: 8 }, () => branchDiffs)
    )

    mux.request.mockReset()
    const pendingCommitDiff = deferredValue(diff)
    mux.request.mockReturnValue(pendingCommitDiff.promise)

    const commitReads = Array.from({ length: 8 }, () =>
      provider.getCommitDiff('/home/user/repo', {
        commitOid: 'c'.repeat(40),
        parentOid: 'b'.repeat(40),
        filePath: 'src/file.ts'
      })
    )

    await waitForRequestCount(mux.request, 1)
    expect(mux.request).toHaveBeenCalledTimes(1)
    pendingCommitDiff.resolve()
    await expect(Promise.all(commitReads)).resolves.toEqual(Array.from({ length: 8 }, () => diff))
  })

  it('retries diff RPCs after an in-flight rejection settles', async () => {
    const failure = new Error('transient relay failure')
    mux.request.mockRejectedValueOnce(failure)

    const firstBurst = Array.from({ length: 8 }, () =>
      provider.getDiff('/home/user/repo', 'src/file.ts', false, true)
    )

    await expect(Promise.all(firstBurst)).rejects.toThrow('transient relay failure')
    expect(mux.request).toHaveBeenCalledTimes(1)

    const diff = {
      kind: 'text',
      originalContent: 'old',
      modifiedContent: 'new',
      originalIsBinary: false,
      modifiedIsBinary: false
    }
    mux.request.mockResolvedValueOnce(diff)

    await expect(provider.getDiff('/home/user/repo', 'src/file.ts', false, true)).resolves.toBe(
      diff
    )
    expect(mux.request).toHaveBeenCalledTimes(2)
  })

  it('clears pending diff RPCs when status runs', async () => {
    const diff = {
      kind: 'text',
      originalContent: 'old',
      modifiedContent: 'new',
      originalIsBinary: false,
      modifiedIsBinary: false
    }
    const pendingDiff = deferredValue(diff)
    mux.request.mockReturnValueOnce(pendingDiff.promise)

    const first = provider.getDiff('/home/user/repo', 'src/file.ts', false, true)
    await waitForRequestCount(mux.request, 1)

    mux.request.mockResolvedValueOnce({ entries: [], conflictOperation: 'unknown' })
    await provider.getStatus('/home/user/repo')

    mux.request.mockResolvedValueOnce(diff)
    const second = provider.getDiff('/home/user/repo', 'src/file.ts', false, true)

    pendingDiff.resolve()
    await expect(Promise.all([first, second])).resolves.toEqual([diff, diff])
    expect(mux.request).toHaveBeenCalledTimes(3)
  })

  it('clears pending diff RPCs when submodule status runs', async () => {
    const diff = {
      kind: 'text',
      originalContent: 'old',
      modifiedContent: 'new',
      originalIsBinary: false,
      modifiedIsBinary: false
    }
    const pendingDiff = deferredValue(diff)
    mux.request.mockReturnValueOnce(pendingDiff.promise)

    const first = provider.getDiff('/home/user/repo', 'src/file.ts', false, true)
    await waitForRequestCount(mux.request, 1)

    mux.request.mockResolvedValueOnce({ entries: [], conflictOperation: 'unknown' })
    await provider.getSubmoduleStatus('/home/user/repo', 'vendor/lib')

    mux.request.mockResolvedValueOnce(diff)
    const second = provider.getDiff('/home/user/repo', 'src/file.ts', false, true)

    pendingDiff.resolve()
    await expect(Promise.all([first, second])).resolves.toEqual([diff, diff])
    expect(mux.request).toHaveBeenCalledTimes(3)
  })

  it('clears pending diff RPCs when a mutation runs', async () => {
    const diff = {
      kind: 'text',
      originalContent: 'old',
      modifiedContent: 'new',
      originalIsBinary: false,
      modifiedIsBinary: false
    }
    const pendingDiff = deferredValue(diff)
    mux.request.mockReturnValueOnce(pendingDiff.promise)

    const first = provider.getDiff('/home/user/repo', 'src/file.ts', false, true)
    await waitForRequestCount(mux.request, 1)

    mux.request.mockResolvedValueOnce(undefined)
    await provider.stageFile('/home/user/repo', 'src/file.ts')

    mux.request.mockResolvedValueOnce(diff)
    const second = provider.getDiff('/home/user/repo', 'src/file.ts', false, true)

    pendingDiff.resolve()
    await expect(Promise.all([first, second])).resolves.toEqual([diff, diff])
    expect(mux.request).toHaveBeenCalledTimes(3)
  })

  it.each([
    [
      'clone',
      (provider: SshGitProvider) =>
        provider.clone(['clone', '--', 'https://example.com/repo.git', 'repo'], '/projects')
    ],
    [
      'mutating git.exec',
      (provider: SshGitProvider) =>
        provider.exec(['commit', '--allow-empty', '-m', 'initialize'], '/home/user/repo')
    ]
  ])('clears pending diff RPCs when %s runs', async (_name, mutate) => {
    const diff = {
      kind: 'text',
      originalContent: 'old',
      modifiedContent: 'new',
      originalIsBinary: false,
      modifiedIsBinary: false
    }
    const pendingDiff = deferredValue(diff)
    mux.request.mockReturnValueOnce(pendingDiff.promise)

    const first = provider.getDiff('/home/user/repo', 'src/file.ts', false, true)
    await waitForRequestCount(mux.request, 1)

    mux.request.mockResolvedValueOnce({ stdout: '', stderr: '' })
    await mutate(provider)

    mux.request.mockResolvedValueOnce(diff)
    const second = provider.getDiff('/home/user/repo', 'src/file.ts', false, true)

    pendingDiff.resolve()
    await expect(Promise.all([first, second])).resolves.toEqual([diff, diff])
    expect(mux.request).toHaveBeenCalledTimes(3)
  })

  it('clears pending branch diff RPCs when a ref-moving provider operation runs', async () => {
    const diff = {
      kind: 'text',
      originalContent: 'old',
      modifiedContent: 'new',
      originalIsBinary: false,
      modifiedIsBinary: false
    }
    const pendingDiff = deferredValue([diff])
    mux.request.mockReturnValueOnce(pendingDiff.promise)

    const first = provider.getBranchDiff('/home/user/repo', 'origin/main', {
      includePatch: true,
      filePath: 'src/file.ts'
    })
    await waitForRequestCount(mux.request, 1)

    mux.request.mockResolvedValueOnce(undefined)
    await provider.fetchRemoteTrackingRef(
      '/home/user/repo',
      'origin',
      'main',
      'refs/remotes/origin/main'
    )

    mux.request.mockResolvedValueOnce([diff])
    const second = provider.getBranchDiff('/home/user/repo', 'origin/main', {
      includePatch: true,
      filePath: 'src/file.ts'
    })

    pendingDiff.resolve()
    await expect(Promise.all([first, second])).resolves.toEqual([[diff], [diff]])
    expect(mux.request).toHaveBeenCalledTimes(3)
  })

  it('coalesces logically identical branch and commit diff RPC args regardless of property order', async () => {
    const diff = {
      kind: 'text',
      originalContent: 'old',
      modifiedContent: 'new',
      originalIsBinary: false,
      modifiedIsBinary: false
    }
    mux.request.mockResolvedValue([diff])

    await Promise.all([
      provider.getBranchDiff('/home/user/repo', 'main', {
        includePatch: true,
        filePath: 'src/file.ts',
        oldPath: 'src/old-file.ts'
      }),
      provider.getBranchDiff('/home/user/repo', 'main', {
        oldPath: 'src/old-file.ts',
        filePath: 'src/file.ts',
        includePatch: true
      })
    ])

    expect(mux.request).toHaveBeenCalledTimes(1)

    mux.request.mockReset()
    mux.request.mockResolvedValue(diff)

    await Promise.all([
      provider.getCommitDiff('/home/user/repo', {
        commitOid: 'c'.repeat(40),
        parentOid: 'b'.repeat(40),
        filePath: 'src/file.ts',
        oldPath: 'src/old-file.ts'
      }),
      provider.getCommitDiff('/home/user/repo', {
        oldPath: 'src/old-file.ts',
        filePath: 'src/file.ts',
        parentOid: 'b'.repeat(40),
        commitOid: 'c'.repeat(40)
      })
    ])

    expect(mux.request).toHaveBeenCalledTimes(1)
  })

  it('keeps distinct diff RPC keys independent', async () => {
    const diff = {
      kind: 'text',
      originalContent: 'old',
      modifiedContent: 'new',
      originalIsBinary: false,
      modifiedIsBinary: false
    }
    mux.request.mockResolvedValue(diff)

    await Promise.all([
      provider.getDiff('/home/user/repo', 'src/file.ts', false, false),
      provider.getDiff('/home/user/repo', 'src/file.ts', true, false),
      provider.getDiff('/home/user/repo', 'src/file.ts', false, true),
      provider.getBranchDiff('/home/user/repo', 'main', {
        includePatch: true,
        filePath: 'src/file.ts'
      }),
      provider.getBranchDiff('/home/user/repo', 'main', {
        includePatch: false,
        filePath: 'src/file.ts'
      }),
      provider.getBranchDiff('/home/user/repo', 'main', {
        includePatch: true,
        filePath: 'src/file.ts',
        oldPath: 'src/old-file.ts'
      }),
      provider.getBranchDiff('/home/user/repo', 'develop', {
        includePatch: true,
        filePath: 'src/file.ts'
      }),
      provider.getCommitDiff('/home/user/repo', {
        commitOid: 'c'.repeat(40),
        parentOid: 'b'.repeat(40),
        filePath: 'src/file.ts'
      }),
      provider.getCommitDiff('/home/user/repo', {
        commitOid: 'c'.repeat(40),
        parentOid: 'a'.repeat(40),
        filePath: 'src/file.ts'
      }),
      provider.getCommitDiff('/home/user/repo', {
        commitOid: 'c'.repeat(40),
        parentOid: 'b'.repeat(40),
        filePath: 'src/file.ts',
        oldPath: 'src/old-file.ts'
      })
    ])

    expect(mux.request).toHaveBeenCalledTimes(10)
  })
})
