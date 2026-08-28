/**
 * GitHandler worktree inspection: porcelain worktree listing (path
 * normalization, cancellation, exotic paths) and the clean/dirty probe.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import type { GitHandler } from './git-handler'
import { gitInit, gitCommit, type MockDispatcher } from './git-handler-test-setup'
import {
  createGitHandlerRelay,
  createGitTempDir,
  removeGitTempDir,
  type GitSpyTarget
} from './git-handler-test-harness'

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

  describe('listWorktrees', () => {
    it('lists worktrees for a repo', async () => {
      gitInit(tmpDir)
      writeFileSync(path.join(tmpDir, 'file.txt'), 'hello')
      gitCommit(tmpDir, 'initial')

      const result = (await dispatcher.callRequest('git.listWorktrees', {
        repoPath: tmpDir
      })) as Record<string, unknown>[]
      expect(result.length).toBeGreaterThanOrEqual(1)
      expect(result[0].isMainWorktree).toBe(true)
    })

    it('passes request cancellation to the git worktree list subprocess', async () => {
      const controller = new AbortController()
      const gitSpy = vi
        .spyOn(handler as unknown as GitSpyTarget, 'git')
        .mockRejectedValue(new Error('aborted'))

      const result = await dispatcher.callRequest(
        'git.listWorktrees',
        { repoPath: tmpDir },
        { isStale: () => false, signal: controller.signal }
      )

      expect(result).toEqual([])
      expect(gitSpy).toHaveBeenCalledWith(['worktree', 'list', '--porcelain', '-z'], tmpDir, {
        signal: controller.signal
      })
    })

    it.skipIf(process.platform === 'win32')(
      'normalizes the main worktree path for a separate-git-dir repo',
      async () => {
        const sourcePath = path.join(tmpDir, 'source')
        const worktreePath = path.join(tmpDir, 'worktree')
        const gitDirPath = path.join(tmpDir, 'git-store', 'project.git')
        mkdirSync(sourcePath)
        mkdirSync(path.dirname(gitDirPath), { recursive: true })
        gitInit(sourcePath)
        writeFileSync(path.join(sourcePath, 'file.txt'), 'hello')
        gitCommit(sourcePath, 'initial')

        execFileSync('git', [
          'clone',
          '--quiet',
          `--separate-git-dir=${gitDirPath}`,
          sourcePath,
          worktreePath
        ])

        const result = (await dispatcher.callRequest('git.listWorktrees', {
          repoPath: await fs.realpath(worktreePath)
        })) as Record<string, unknown>[]
        const mainWorktree = result.find((worktree) => worktree.isMainWorktree === true)

        expect(mainWorktree).toMatchObject({
          path: await fs.realpath(worktreePath),
          isMainWorktree: true
        })
        expect(mainWorktree?.path).not.toBe(await fs.realpath(gitDirPath))
      }
    )

    it.skipIf(process.platform === 'win32')(
      'leaves an ordinary repo reached via a symlinked path unchanged',
      async () => {
        // A symlink alias defeats the path-string gate; the git-common-dir gate must still skip rewrite for an ordinary repo.
        const repoPath = path.join(tmpDir, 'plain-repo')
        mkdirSync(repoPath)
        gitInit(repoPath)
        writeFileSync(path.join(repoPath, 'file.txt'), 'hello')
        gitCommit(repoPath, 'initial')
        const linkedRepoPath = path.join(tmpDir, 'linked-repo')
        symlinkSync(repoPath, linkedRepoPath)

        const result = (await dispatcher.callRequest('git.listWorktrees', {
          repoPath: linkedRepoPath
        })) as Record<string, unknown>[]
        const mainWorktree = result.find((worktree) => worktree.isMainWorktree === true)

        expect(mainWorktree).toMatchObject({
          path: await fs.realpath(repoPath),
          isMainWorktree: true
        })
      }
    )

    it.skipIf(process.platform === 'win32')(
      'leaves the main entry unchanged when scanned via a linked worktree',
      async () => {
        // The git-common-dir gate must skip rewrite so a linked worktree's main entry isn't overwritten with its own toplevel.
        const repoPath = path.join(tmpDir, 'main-repo')
        mkdirSync(repoPath)
        gitInit(repoPath)
        writeFileSync(path.join(repoPath, 'file.txt'), 'hello')
        gitCommit(repoPath, 'initial')
        const linkedWorktreePath = path.join(tmpDir, 'linked-wt')
        execFileSync('git', ['worktree', 'add', '--quiet', linkedWorktreePath, '-b', 'feature'], {
          cwd: repoPath,
          stdio: 'pipe'
        })
        const resolvedLinked = await fs.realpath(linkedWorktreePath)

        const result = (await dispatcher.callRequest('git.listWorktrees', {
          repoPath: resolvedLinked
        })) as Record<string, unknown>[]
        const mainWorktree = result.find((worktree) => worktree.isMainWorktree === true)

        expect(mainWorktree).toMatchObject({
          path: await fs.realpath(repoPath),
          isMainWorktree: true
        })
        expect(mainWorktree?.path).not.toBe(resolvedLinked)
      }
    )

    it.skipIf(process.platform === 'win32')(
      'lists worktrees whose paths contain newlines',
      async () => {
        gitInit(tmpDir)
        writeFileSync(path.join(tmpDir, 'file.txt'), 'hello')
        gitCommit(tmpDir, 'initial')
        const worktreePath = path.join(
          path.dirname(tmpDir),
          `${path.basename(tmpDir)}-linked\nremote`
        )

        try {
          execFileSync(
            'git',
            ['worktree', 'add', '--quiet', '-b', 'feature/newline', worktreePath],
            {
              cwd: tmpDir,
              stdio: 'pipe'
            }
          )
          const realWorktreePath = await fs.realpath(worktreePath)

          const result = (await dispatcher.callRequest('git.listWorktrees', {
            repoPath: tmpDir
          })) as Record<string, unknown>[]

          expect(result.map((worktree) => worktree.path)).toContain(realWorktreePath)
        } finally {
          await fs.rm(worktreePath, { recursive: true, force: true })
        }
      }
    )
  })

  describe('worktreeIsClean', () => {
    it('can ignore untracked files', async () => {
      gitInit(tmpDir)
      writeFileSync(path.join(tmpDir, 'tracked.txt'), 'initial')
      gitCommit(tmpDir, 'initial')
      writeFileSync(path.join(tmpDir, 'scratch.txt'), 'untracked')

      await expect(
        dispatcher.callRequest('git.worktreeIsClean', { worktreePath: tmpDir })
      ).resolves.toEqual({
        clean: false,
        stdout: expect.stringContaining('scratch.txt')
      })
      await expect(
        dispatcher.callRequest('git.worktreeIsClean', {
          worktreePath: tmpDir,
          includeUntracked: false
        })
      ).resolves.toEqual({ clean: true })
    })
  })
})
