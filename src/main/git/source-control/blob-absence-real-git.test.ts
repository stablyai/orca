import { readFile, unlink, utimes, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runProcess } from '@orca/process-host'
import { gitCommit, gitInit, type MockDispatcher } from '../../../relay/git-handler-test-setup'
import {
  createGitHandlerRelay,
  createGitTempDir,
  removeGitTempDir
} from '../../../relay/git-handler-test-harness'
import type { GitHandler } from '../../../relay/git-handler'
import { isMissingGitBlobPath } from '../../../shared/git-blob-absence'
import { readGitBlobAtIndexPath } from './git-blob-read'
import { getDiff } from './file-diff'
import { invalidateGitReadCaches, settledDiffCache } from './git-read-cache-invalidation'
import { readWorktreeDiffStamp } from './worktree-diff-stamp'

describe('real Git missing paths and failed blob reads', () => {
  let repo: string
  let dispatcher: MockDispatcher
  let handler: GitHandler

  beforeEach(() => {
    repo = createGitTempDir()
    ;({ dispatcher, handler } = createGitHandlerRelay())
    gitInit(repo)
    invalidateGitReadCaches()
  })

  afterEach(async () => {
    handler.dispose()
    invalidateGitReadCaches()
    await removeGitTempDir(repo)
  })

  async function git(args: string[], input?: string): Promise<string> {
    const result = await runProcess({ program: 'git', args, cwd: repo, input })
    expect(result.code, result.stderr).toBe(0)
    return result.stdout
  }

  function diff(host: 'native' | 'relay', staged = false): Promise<unknown> {
    return host === 'native'
      ? getDiff(repo, 'file.txt', staged)
      : dispatcher.callRequest('git.diff', { worktreePath: repo, filePath: 'file.txt', staged })
  }

  it.each(['native', 'relay'] as const)(
    'does not substitute HEAD for a corrupt index blob on %s',
    async (host) => {
      await writeFile(path.join(repo, 'file.txt'), 'committed\n')
      gitCommit(repo, 'initial')
      await writeFile(path.join(repo, 'file.txt'), 'staged\n')
      await git(['add', 'file.txt'])
      const oid = (await git(['rev-parse', ':file.txt'])).trim()
      await writeFile(path.join(repo, 'file.txt'), 'working\n')
      const old = new Date(Date.now() - 10_000)
      await Promise.all(
        ['.git/index', 'file.txt'].map((file) => utimes(path.join(repo, file), old, old))
      )
      const before = await readWorktreeDiffStamp(repo, 'file.txt', true)
      await unlink(path.join(repo, '.git', 'objects', oid.slice(0, 2), oid.slice(2)))
      expect(await readGitBlobAtIndexPath(repo, 'file.txt')).toMatchObject({
        exists: false,
        failed: true
      })

      expect(await diff(host)).toMatchObject({ originalContent: '', modifiedContent: 'working\n' })
      if (host === 'native') {
        expect(settledDiffCache.stats().entries).toBe(0)
      }
      await git(['hash-object', '-w', '--stdin'], 'staged\n')
      const after = await readWorktreeDiffStamp(repo, 'file.txt', true)
      expect(after?.value).toBe(before?.value)

      expect(await diff(host)).toMatchObject({
        originalContent: 'staged\n',
        modifiedContent: 'working\n'
      })
      if (host === 'native') {
        expect(settledDiffCache.stats().entries).toBe(1)
      }
    }
  )

  it.each(['native', 'relay'] as const)(
    'retains added paths on an unborn branch on %s',
    async (host) => {
      await writeFile(path.join(repo, 'file.txt'), 'new file\n')
      await git(['add', 'file.txt'])
      expect(await diff(host, true)).toMatchObject({
        originalContent: '',
        modifiedContent: 'new file\n'
      })
    }
  )

  it.each(['native', 'relay'] as const)(
    'retains additions absent from a valid HEAD tree on %s',
    async (host) => {
      await writeFile(path.join(repo, 'seed.txt'), 'seed\n')
      gitCommit(repo, 'initial')
      await writeFile(path.join(repo, 'file.txt'), 'new file\n')
      await git(['add', 'file.txt'])
      expect(await diff(host, true)).toMatchObject({
        originalContent: '',
        modifiedContent: 'new file\n'
      })
    }
  )

  it('recognizes actual index and tree absence without accepting corrupt objects', async () => {
    await writeFile(path.join(repo, 'seed.txt'), 'seed\n')
    gitCommit(repo, 'initial')
    const names = ['file.txt', ...(process.platform === 'win32' ? [] : ["quote' and\nnewline.txt"])]
    for (const filePath of names) {
      for (const presentOnDisk of [false, true]) {
        if (presentOnDisk) {
          await writeFile(path.join(repo, filePath), 'untracked\n')
        }
        for (const oid of [undefined, 'HEAD']) {
          const result = await runProcess({
            program: 'git',
            args: ['show', '--end-of-options', `${oid ?? ''}:${filePath}`],
            cwd: repo
          })
          expect(
            isMissingGitBlobPath({ code: result.code, stderr: result.stderr }, filePath, oid)
          ).toBe(true)
        }
      }
    }
    expect(await readFile(path.join(repo, 'seed.txt'), 'utf8')).toBe('seed\n')
  })
})
