import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { runProcess } from '@orca/process-host'
import { afterEach, describe, expect, it } from 'vitest'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import type { RuntimeGitTarget } from './runtime-git-command-target'
import { RuntimeGitDiffCommands } from './runtime-git-diff-commands'

function commands(root: string, localGitOptions?: RuntimeGitTarget['localGitOptions']) {
  const gitInfo = {
    path: root,
    head: 'a'.repeat(40),
    branch: 'main',
    isBare: false,
    isMainWorktree: true
  }
  return new RuntimeGitDiffCommands({
    resolveRuntimeGitTarget: async () => ({
      executionHostId: 'local',
      localGitOptions,
      worktree: {
        ...gitInfo,
        git: gitInfo,
        id: 'wt-1',
        repoId: 'repo-1',
        displayName: 'Test repository',
        comment: '',
        linkedIssue: null,
        linkedPR: null,
        linkedLinearIssue: null,
        isArchived: false,
        isUnread: false,
        isPinned: false,
        sortOrder: 0,
        lastActivityAt: 0
      }
    }),
    getRuntimeSettings: () => createGlobalSettingsFixture()
  })
}

describe.skipIf(process.platform === 'win32')('runtime commit diff POSIX path identity', () => {
  let repo: string | undefined

  afterEach(async () => {
    if (repo) {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it.each([false, true])('reads literal backslashes with rename=%s', async (renamed) => {
    repo = await mkdtemp(path.join(tmpdir(), 'orca-commit-diff-paths-'))
    const root = repo
    const git = async (args: string[]): Promise<string> => {
      const result = await runProcess({
        program: 'git',
        args,
        cwd: root,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'Test User',
          GIT_AUTHOR_EMAIL: 'test@example.com',
          GIT_COMMITTER_NAME: 'Test User',
          GIT_COMMITTER_EMAIL: 'test@example.com'
        }
      })
      expect(result.code, result.stderr).toBe(0)
      return result.stdout.trim()
    }
    const filePath = 'docs\\file.txt'
    const oldPath = renamed ? 'docs\\old-file.txt' : filePath
    await git(['init'])
    await mkdir(path.join(root, 'docs'))
    await writeFile(path.join(root, 'docs/file.txt'), 'nested current\n')
    await writeFile(path.join(root, 'docs/old-file.txt'), 'nested previous\n')
    await writeFile(path.join(root, oldPath), 'literal original\n')
    await git(['add', '.'])
    await git(['-c', 'commit.gpgsign=false', 'commit', '-m', 'initial'])
    const parentOid = await git(['rev-parse', 'HEAD'])
    if (renamed) {
      await rename(path.join(root, oldPath), path.join(root, filePath))
    }
    await writeFile(path.join(root, filePath), 'literal modified\n')
    await git(['add', '.'])
    await git(['-c', 'commit.gpgsign=false', 'commit', '-m', 'update'])
    const commitOid = await git(['rev-parse', 'HEAD'])

    await expect(
      commands(root).getRuntimeGitCommitDiff('id:wt-1', {
        commitOid,
        parentOid,
        filePath,
        ...(renamed ? { oldPath } : {})
      })
    ).resolves.toMatchObject({
      kind: 'text',
      originalContent: 'literal original\n',
      modifiedContent: 'literal modified\n'
    })
  })
})
