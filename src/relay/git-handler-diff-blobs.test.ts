import { writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runProcess } from '@orca/process-host'
import { commitDiffEntry } from './git-handler-commit-diff-ops'
import { computeDiff, type GitBufferExec } from './git-handler-ops'
import { gitCommit, gitInit, type MockDispatcher } from './git-handler-test-setup'
import {
  createGitHandlerRelay,
  createGitTempDir,
  removeGitTempDir
} from './git-handler-test-harness'
import type { GitHandler } from './git-handler'

describe('relay diff blob reads', () => {
  let tmpDir: string
  let dispatcher: MockDispatcher
  let handler: GitHandler

  beforeEach(() => {
    tmpDir = createGitTempDir()
    ;({ dispatcher, handler } = createGitHandlerRelay())
  })

  afterEach(async () => {
    handler.dispose()
    await removeGitTempDir(tmpDir)
  })

  it('shows an untracked text file named maxBuffer as text', async () => {
    gitInit(tmpDir)
    await writeFile(path.join(tmpDir, 'base.txt'), 'base\n')
    gitCommit(tmpDir, 'initial')
    await writeFile(path.join(tmpDir, 'maxBuffer'), 'plain text addition\n')
    const result = await dispatcher.callRequest('git.diff', {
      worktreePath: tmpDir,
      filePath: 'maxBuffer',
      staged: false
    })
    expect(result).toMatchObject({
      kind: 'text',
      originalContent: '',
      modifiedContent: 'plain text addition\n'
    })
  })

  it('uses an empty index blob as the unstaged baseline without reading HEAD', async () => {
    gitInit(tmpDir)
    await writeFile(path.join(tmpDir, 'file.txt'), 'committed\n')
    gitCommit(tmpDir, 'initial')
    await writeFile(path.join(tmpDir, 'file.txt'), '')
    const staged = await runProcess({ program: 'git', args: ['add', 'file.txt'], cwd: tmpDir })
    expect(staged.code).toBe(0)
    await writeFile(path.join(tmpDir, 'file.txt'), 'working\n')

    const result = await dispatcher.callRequest('git.diff', {
      worktreePath: tmpDir,
      filePath: 'file.txt',
      staged: false
    })

    expect(result).toMatchObject({
      kind: 'text',
      originalContent: '',
      modifiedContent: 'working\n'
    })
  })

  it('still falls back to HEAD after a staged deletion', async () => {
    gitInit(tmpDir)
    await writeFile(path.join(tmpDir, 'file.txt'), 'committed\n')
    gitCommit(tmpDir, 'initial')
    const removed = await runProcess({
      program: 'git',
      args: ['rm', '--cached', 'file.txt'],
      cwd: tmpDir
    })
    expect(removed.code).toBe(0)
    await writeFile(path.join(tmpDir, 'file.txt'), 'working\n')

    const result = await dispatcher.callRequest('git.diff', {
      worktreePath: tmpDir,
      filePath: 'file.txt',
      staged: false
    })

    expect(result).toMatchObject({
      kind: 'text',
      originalContent: 'committed\n',
      modifiedContent: 'working\n'
    })
  })
})

describe('independent relay blob reads', () => {
  function deferredBlobs() {
    const releases: (() => void)[] = []
    const gitBuffer = vi.fn<GitBufferExec>(
      (args) =>
        new Promise<Buffer>((resolve) => {
          const content =
            args[2].startsWith(':') || args[2].startsWith('b'.repeat(40))
              ? 'modified\n'
              : 'original\n'
          releases.push(() => resolve(Buffer.from(content)))
        })
    )
    return { gitBuffer, releases }
  }

  it.each(['staged', 'commit'] as const)(
    'starts both %s sides before either completes',
    async (kind) => {
      const { gitBuffer, releases } = deferredBlobs()
      const resultPromise =
        kind === 'staged'
          ? computeDiff(gitBuffer, '/repo', 'file.txt', true)
          : commitDiffEntry(gitBuffer, '/repo', {
              commitOid: 'b'.repeat(40),
              parentOid: 'a'.repeat(40),
              filePath: 'file.txt'
            })
      const readsStartedTogether = gitBuffer.mock.calls.length
      // Why iterative: the old sequential implementation starts its second read after the first resolves.
      for (let i = 0; i < 2; i += 1) {
        releases[i]?.()
        await Promise.resolve()
        await Promise.resolve()
      }
      const result = await resultPromise

      expect(readsStartedTogether).toBe(2)
      expect(gitBuffer).toHaveBeenCalledTimes(2)
      expect(result).toMatchObject({
        kind: 'text',
        originalContent: 'original\n',
        modifiedContent: 'modified\n'
      })
    }
  )

  it('reads only the right side for a root commit', async () => {
    const gitBuffer = vi.fn<GitBufferExec>().mockResolvedValue(Buffer.from('added\n'))
    const result = await commitDiffEntry(gitBuffer, '/repo', {
      commitOid: 'b'.repeat(40),
      filePath: 'file.txt'
    })

    expect(gitBuffer).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ originalContent: '', modifiedContent: 'added\n' })
  })
})
