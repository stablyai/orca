/**
 * GitHandler relay diff-read coalescing: in-flight sharing of identical
 * diff/branchDiff/commitDiff blob reads, and the invalidation points that
 * force a fresh read.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import * as path from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import type { GitHandler } from './git-handler'
import { gitInit, gitCommit, type MockDispatcher } from './git-handler-test-setup'
import {
  createGitHandlerRelay,
  createGitTempDir,
  removeGitTempDir,
  type GitBufferSpyTarget,
  type GitSpyTarget
} from './git-handler-test-harness'

function deferredRelayBuffer(content: string): {
  promise: Promise<Buffer>
  resolve: () => void
} {
  let resolve!: (value: Buffer) => void
  const promise = new Promise<Buffer>((innerResolve) => {
    resolve = innerResolve
  })
  return {
    promise,
    resolve: () => resolve(Buffer.from(content))
  }
}

async function waitForSpyCalls(mock: ReturnType<typeof vi.fn>, calls: number): Promise<void> {
  for (let i = 0; i < 20; i++) {
    if (mock.mock.calls.length >= calls) {
      return
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
}

describe('GitHandler', () => {
  let dispatcher: MockDispatcher
  let handler: GitHandler
  let tmpDir: string

  beforeEach(() => {
    tmpDir = createGitTempDir()
    ;({ dispatcher, handler } = createGitHandlerRelay())
  })

  afterEach(async () => {
    await removeGitTempDir(tmpDir)
  })

  describe('branchDiff', () => {
    it('coalesces concurrent identical git.diff reads while in flight and reads fresh after settle', async () => {
      const leftBlob = deferredRelayBuffer('left\n')
      const rightBlob = deferredRelayBuffer('right\n')
      const pendingBuffers = [leftBlob, rightBlob]
      const gitBufferSpy = vi
        .spyOn(handler as unknown as GitBufferSpyTarget, 'gitBuffer')
        .mockImplementation(async () => pendingBuffers.shift()!.promise)

      const reads = Array.from({ length: 8 }, () =>
        dispatcher.callRequest('git.diff', {
          worktreePath: tmpDir,
          filePath: 'src/file.ts',
          staged: true
        })
      )

      await waitForSpyCalls(gitBufferSpy, 1)
      leftBlob.resolve()
      await waitForSpyCalls(gitBufferSpy, 2)
      rightBlob.resolve()

      await Promise.all(reads)

      expect(gitBufferSpy).toHaveBeenCalledTimes(2)

      gitBufferSpy
        .mockResolvedValueOnce(Buffer.from('fresh-left\n'))
        .mockResolvedValueOnce(Buffer.from('fresh-right\n'))

      await dispatcher.callRequest('git.diff', {
        worktreePath: tmpDir,
        filePath: 'src/file.ts',
        staged: true
      })

      expect(gitBufferSpy).toHaveBeenCalledTimes(4)
    })

    it('clears pending git.diff reads when status runs', async () => {
      const firstBlob = deferredRelayBuffer('left\n')
      const secondBlob = deferredRelayBuffer('fresh-left\n')
      const pendingBuffers = [firstBlob, secondBlob]
      const gitBufferSpy = vi
        .spyOn(handler as unknown as GitBufferSpyTarget, 'gitBuffer')
        .mockImplementation(async () => pendingBuffers.shift()!.promise)
      const gitSpy = vi
        .spyOn(handler as unknown as GitSpyTarget, 'git')
        .mockResolvedValue({ stdout: '', stderr: '' })

      const first = dispatcher.callRequest('git.diff', {
        worktreePath: tmpDir,
        filePath: 'src/file.ts',
        staged: false
      })
      await waitForSpyCalls(gitBufferSpy, 1)

      await dispatcher.callRequest('git.status', { worktreePath: tmpDir })

      const second = dispatcher.callRequest('git.diff', {
        worktreePath: tmpDir,
        filePath: 'src/file.ts',
        staged: false
      })
      await waitForSpyCalls(gitBufferSpy, 2)

      firstBlob.resolve()
      secondBlob.resolve()
      await Promise.all([first, second])

      expect(gitBufferSpy).toHaveBeenCalledTimes(2)
      expect(gitSpy).toHaveBeenCalled()
    })

    it('clears pending git.diff reads when a mutation runs', async () => {
      const firstBlob = deferredRelayBuffer('left\n')
      const secondBlob = deferredRelayBuffer('fresh-left\n')
      const pendingBuffers = [firstBlob, secondBlob]
      const gitBufferSpy = vi
        .spyOn(handler as unknown as GitBufferSpyTarget, 'gitBuffer')
        .mockImplementation(async () => pendingBuffers.shift()!.promise)
      const gitSpy = vi
        .spyOn(handler as unknown as GitSpyTarget, 'git')
        .mockResolvedValue({ stdout: '', stderr: '' })

      const first = dispatcher.callRequest('git.diff', {
        worktreePath: tmpDir,
        filePath: 'src/file.ts',
        staged: false
      })
      await waitForSpyCalls(gitBufferSpy, 1)

      await dispatcher.callRequest('git.stage', { worktreePath: tmpDir, filePath: 'src/file.ts' })

      const second = dispatcher.callRequest('git.diff', {
        worktreePath: tmpDir,
        filePath: 'src/file.ts',
        staged: false
      })
      await waitForSpyCalls(gitBufferSpy, 2)

      firstBlob.resolve()
      secondBlob.resolve()
      await Promise.all([first, second])

      expect(gitBufferSpy).toHaveBeenCalledTimes(2)
      expect(gitSpy).toHaveBeenCalledWith(['add', '--', ':(literal)src/file.ts'], tmpDir)
      const submodulePathReads = gitSpy.mock.calls.filter(
        ([args]) => args[0] === 'config' && args.includes('.gitmodules')
      )
      expect(submodulePathReads).toHaveLength(2)
    })

    it('clears pending git.diff reads when a narrow ref fetch runs', async () => {
      const firstBlob = deferredRelayBuffer('left\n')
      const secondBlob = deferredRelayBuffer('fresh-left\n')
      const pendingBuffers = [firstBlob, secondBlob]
      const gitBufferSpy = vi
        .spyOn(handler as unknown as GitBufferSpyTarget, 'gitBuffer')
        .mockImplementation(async () => pendingBuffers.shift()!.promise)
      const gitSpy = vi
        .spyOn(handler as unknown as GitSpyTarget, 'git')
        .mockImplementation(async (args: string[]) => {
          if (args[0] === 'remote') {
            return { stdout: 'origin\n', stderr: '' }
          }
          return { stdout: '', stderr: '' }
        })

      const first = dispatcher.callRequest('git.diff', {
        worktreePath: tmpDir,
        filePath: 'src/file.ts',
        staged: false
      })
      await waitForSpyCalls(gitBufferSpy, 1)

      await dispatcher.callRequest('git.fetchRemoteTrackingRef', {
        worktreePath: tmpDir,
        remote: 'origin',
        branch: 'main',
        ref: 'refs/remotes/origin/main',
        skipAutoMaintenance: true
      })

      const second = dispatcher.callRequest('git.diff', {
        worktreePath: tmpDir,
        filePath: 'src/file.ts',
        staged: false
      })
      await waitForSpyCalls(gitBufferSpy, 2)

      firstBlob.resolve()
      secondBlob.resolve()
      await Promise.all([first, second])

      expect(gitBufferSpy).toHaveBeenCalledTimes(2)
      expect(gitSpy).toHaveBeenCalledWith(
        [
          '-c',
          'maintenance.auto=false',
          '-c',
          'maintenance.commit-graph.auto=0',
          '-c',
          'gc.auto=0',
          'fetch',
          '--no-tags',
          'origin',
          '+refs/heads/main:refs/remotes/origin/main'
        ],
        tmpDir
      )
    })

    it('coalesces concurrent identical git.branchDiff reads while in flight', async () => {
      const gitSpy = vi
        .spyOn(handler as unknown as GitSpyTarget, 'git')
        .mockImplementation(async (args: string[]) => {
          if (args[0] === 'rev-parse' && args.includes('HEAD')) {
            return { stdout: `${'c'.repeat(40)}\n`, stderr: '' }
          }
          if (args[0] === 'rev-parse') {
            return { stdout: `${'b'.repeat(40)}\n`, stderr: '' }
          }
          if (args[0] === 'merge-base') {
            return { stdout: `${'a'.repeat(40)}\n`, stderr: '' }
          }
          if (args.includes('--name-status')) {
            return { stdout: 'M\tsrc/file.ts\n', stderr: '' }
          }
          throw new Error(`unexpected git args: ${args.join(' ')}`)
        })
      const leftBlob = deferredRelayBuffer('left\n')
      const rightBlob = deferredRelayBuffer('right\n')
      const pendingBuffers = [leftBlob, rightBlob]
      const gitBufferSpy = vi
        .spyOn(handler as unknown as GitBufferSpyTarget, 'gitBuffer')
        .mockImplementation(async () => pendingBuffers.shift()!.promise)

      const reads = Array.from({ length: 8 }, () =>
        dispatcher.callRequest('git.branchDiff', {
          worktreePath: tmpDir,
          baseRef: 'main',
          includePatch: true,
          filePath: 'src/file.ts'
        })
      )

      await waitForSpyCalls(gitBufferSpy, 1)
      leftBlob.resolve()
      await waitForSpyCalls(gitBufferSpy, 2)
      rightBlob.resolve()

      await Promise.all(reads)

      expect(gitBufferSpy).toHaveBeenCalledTimes(2)
      expect(gitSpy).toHaveBeenCalledTimes(4)
    })

    it('coalesces concurrent identical git.commitDiff reads while in flight', async () => {
      const leftBlob = deferredRelayBuffer('left\n')
      const rightBlob = deferredRelayBuffer('right\n')
      const pendingBuffers = [leftBlob, rightBlob]
      const gitBufferSpy = vi
        .spyOn(handler as unknown as GitBufferSpyTarget, 'gitBuffer')
        .mockImplementation(async () => pendingBuffers.shift()!.promise)

      const reads = Array.from({ length: 8 }, () =>
        dispatcher.callRequest('git.commitDiff', {
          worktreePath: tmpDir,
          commitOid: 'c'.repeat(40),
          parentOid: 'b'.repeat(40),
          filePath: 'src/file.ts'
        })
      )

      await waitForSpyCalls(gitBufferSpy, 1)
      leftBlob.resolve()
      await waitForSpyCalls(gitBufferSpy, 2)
      rightBlob.resolve()

      await Promise.all(reads)

      expect(gitBufferSpy).toHaveBeenCalledTimes(2)
    })

    it('coalesces parentless root git.commitDiff reads without a left-side blob', async () => {
      const rightBlob = deferredRelayBuffer('right\n')
      const gitBufferSpy = vi
        .spyOn(handler as unknown as GitBufferSpyTarget, 'gitBuffer')
        .mockImplementation(async () => rightBlob.promise)

      const reads = Array.from({ length: 8 }, () =>
        dispatcher.callRequest('git.commitDiff', {
          worktreePath: tmpDir,
          commitOid: 'c'.repeat(40),
          parentOid: null,
          filePath: 'src/file.ts'
        })
      )

      await waitForSpyCalls(gitBufferSpy, 1)
      rightBlob.resolve()
      await Promise.all(reads)

      expect(gitBufferSpy).toHaveBeenCalledTimes(1)
    })

    it('keeps distinct relay diff keys independent', async () => {
      const gitBufferSpy = vi
        .spyOn(handler as unknown as GitBufferSpyTarget, 'gitBuffer')
        .mockResolvedValue(Buffer.from('blob\n'))

      await Promise.all([
        dispatcher.callRequest('git.diff', {
          worktreePath: tmpDir,
          filePath: 'src/file.ts',
          staged: true
        }),
        dispatcher.callRequest('git.diff', {
          worktreePath: tmpDir,
          filePath: 'src/file.ts',
          staged: false,
          compareAgainstHead: true
        })
      ])

      expect(gitBufferSpy).toHaveBeenCalledTimes(3)

      gitBufferSpy.mockClear()
      const gitSpy = vi
        .spyOn(handler as unknown as GitSpyTarget, 'git')
        .mockImplementation(async (args: string[]) => {
          if (args[0] === 'rev-parse' && args.includes('HEAD')) {
            return { stdout: `${'c'.repeat(40)}\n`, stderr: '' }
          }
          if (args[0] === 'rev-parse' && args.includes('develop')) {
            return { stdout: `${'d'.repeat(40)}\n`, stderr: '' }
          }
          if (args[0] === 'rev-parse') {
            return { stdout: `${'b'.repeat(40)}\n`, stderr: '' }
          }
          if (args[0] === 'merge-base' && args.includes('d'.repeat(40))) {
            return { stdout: `${'e'.repeat(40)}\n`, stderr: '' }
          }
          if (args[0] === 'merge-base') {
            return { stdout: `${'a'.repeat(40)}\n`, stderr: '' }
          }
          if (args.includes('--name-status')) {
            return { stdout: 'M\tsrc/file.ts\n', stderr: '' }
          }
          throw new Error(`unexpected git args: ${args.join(' ')}`)
        })

      await Promise.all([
        dispatcher.callRequest('git.branchDiff', {
          worktreePath: tmpDir,
          baseRef: 'main',
          includePatch: true,
          filePath: 'src/file.ts'
        }),
        dispatcher.callRequest('git.branchDiff', {
          worktreePath: tmpDir,
          baseRef: 'main',
          includePatch: false,
          filePath: 'src/file.ts'
        }),
        dispatcher.callRequest('git.branchDiff', {
          worktreePath: tmpDir,
          baseRef: 'develop',
          includePatch: true,
          filePath: 'src/file.ts'
        })
      ])

      expect(gitSpy).toHaveBeenCalledTimes(12)
      expect(gitBufferSpy).toHaveBeenCalledTimes(4)

      gitBufferSpy.mockClear()

      await Promise.all([
        dispatcher.callRequest('git.commitDiff', {
          worktreePath: tmpDir,
          commitOid: 'c'.repeat(40),
          parentOid: 'b'.repeat(40),
          filePath: 'src/file.ts'
        }),
        dispatcher.callRequest('git.commitDiff', {
          worktreePath: tmpDir,
          commitOid: 'c'.repeat(40),
          parentOid: 'a'.repeat(40),
          filePath: 'src/file.ts'
        }),
        dispatcher.callRequest('git.commitDiff', {
          worktreePath: tmpDir,
          commitOid: 'c'.repeat(40),
          parentOid: 'b'.repeat(40),
          filePath: 'src/file.ts',
          oldPath: 'src/old-a.ts'
        }),
        dispatcher.callRequest('git.commitDiff', {
          worktreePath: tmpDir,
          commitOid: 'c'.repeat(40),
          parentOid: 'b'.repeat(40),
          filePath: 'src/file.ts',
          oldPath: 'src/old-b.ts'
        })
      ])

      expect(gitBufferSpy).toHaveBeenCalledTimes(8)
    })

    it('retries relay diff reads after an in-flight rejection settles', async () => {
      const invalidRequest = {
        worktreePath: tmpDir,
        commitOid: 'not-a-full-oid',
        parentOid: 'b'.repeat(40),
        filePath: 'src/file.ts'
      }
      const first = dispatcher.callRequest('git.commitDiff', invalidRequest)
      const firstBurst = [
        first,
        ...Array.from({ length: 7 }, () => dispatcher.callRequest('git.commitDiff', invalidRequest))
      ]

      await expect(Promise.all(firstBurst)).rejects.toThrow(
        'commitOid must be a full git object id'
      )

      const retry = dispatcher.callRequest('git.commitDiff', invalidRequest)
      expect(retry).not.toBe(first)
      await expect(retry).rejects.toThrow('commitOid must be a full git object id')
    })

    // Why: regression for #1503 on git.branchDiff — branchDiffEntries is a separate quotePath=false path that must round-trip UTF-8.
    it('preserves UTF-8 paths in branch-diff entries', async () => {
      gitInit(tmpDir)
      writeFileSync(path.join(tmpDir, 'base.txt'), 'base')
      gitCommit(tmpDir, 'initial')

      const baseRef = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: tmpDir,
        encoding: 'utf-8'
      }).trim()

      execFileSync('git', ['checkout', '-b', 'feature'], { cwd: tmpDir, stdio: 'pipe' })
      const utf8Dir = path.join(tmpDir, 'docs', '日本語')
      mkdirSync(utf8Dir, { recursive: true })
      writeFileSync(path.join(utf8Dir, 'sample.md'), 'hello')
      gitCommit(tmpDir, 'feature commit')

      const result = (await dispatcher.callRequest('git.branchDiff', {
        worktreePath: tmpDir,
        baseRef,
        filePath: 'docs/日本語/sample.md'
      })) as Record<string, unknown>[]

      // length===1 confirms the path filter matched the raw UTF-8 path; octal-quoted (default quotePath) wouldn't match.
      expect(result).toHaveLength(1)
    })
  })
})
