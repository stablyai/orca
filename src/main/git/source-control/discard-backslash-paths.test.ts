import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runProcess } from '@orca/process-host'
import { createGlobalSettingsFixture } from '../../../shared/global-settings-test-fixture'
import { RuntimeGitStagingCommands } from '../../runtime/runtime-git-staging-commands'
import { bulkDiscardChanges } from './discard-changes'

// Windows filenames cannot contain literal backslashes.
describe.skipIf(process.platform === 'win32')('discard preserves POSIX path identity', () => {
  let repo: string
  let commands: RuntimeGitStagingCommands

  async function git(args: string[]): Promise<string> {
    const result = await runProcess({ program: 'git', args, cwd: repo })
    expect(result.code, result.stderr).toBe(0)
    return result.stdout
  }

  beforeEach(async () => {
    repo = await mkdtemp(path.join(tmpdir(), 'orca-discard-paths-'))
    await git(['init'])
    await git(['config', 'user.email', 'test@example.com'])
    await git(['config', 'user.name', 'Test User'])
    const gitInfo = {
      path: repo,
      head: 'a'.repeat(40),
      branch: 'main',
      isBare: false,
      isMainWorktree: true
    }
    commands = new RuntimeGitStagingCommands({
      resolveRuntimeGitTarget: async () => ({
        executionHostId: 'local',
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
  })

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true })
  })

  for (const host of ['native', 'runtime'] as const) {
    it.each([
      { tracked: 'docs/file.txt', untracked: 'docs\\file.txt', untrackedFile: 'docs\\file.txt' },
      { tracked: 'docs\\file.txt', untracked: 'docs/file.txt', untrackedFile: 'docs/file.txt' },
      { tracked: 'docs\\file.txt', untracked: 'docs', untrackedFile: 'docs/scratch.txt' }
    ])(`discards $untracked separately from tracked $tracked on ${host}`, async (fixture) => {
      const trackedFile = path.join(repo, fixture.tracked)
      await mkdir(path.dirname(trackedFile), { recursive: true })
      await writeFile(trackedFile, 'committed\n')
      await git(['add', '.'])
      await git(['commit', '-m', 'initial'])
      await writeFile(trackedFile, 'staged\n')
      await git(['add', '--', `:(literal)${fixture.tracked}`])
      await writeFile(trackedFile, 'modified\n')

      const untrackedFile = path.join(repo, fixture.untrackedFile)
      await mkdir(path.dirname(untrackedFile), { recursive: true })
      await writeFile(untrackedFile, 'untracked\n')
      await writeFile(path.join(repo, 'leave.txt'), 'unselected\n')

      const filePaths = [fixture.tracked, fixture.untracked]
      await (host === 'native'
        ? bulkDiscardChanges(repo, filePaths)
        : commands.bulkDiscardRuntimeGitPaths('id:wt-1', filePaths))

      expect(await readFile(trackedFile, 'utf8')).toBe('staged\n')
      expect(await git(['show', `:${fixture.tracked}`])).toBe('staged\n')
      await expect(readFile(untrackedFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readFile(path.join(repo, 'leave.txt'), 'utf8')).toBe('unselected\n')
    })
  }

  it('discards a literal-backslash file without touching its slash-named neighbor on runtime', async () => {
    await mkdir(path.join(repo, 'docs'))
    await writeFile(path.join(repo, 'docs/file.txt'), 'keep\n')
    await writeFile(path.join(repo, 'docs\\file.txt'), 'committed\n')
    await git(['add', '.'])
    await git(['commit', '-m', 'initial'])
    await writeFile(path.join(repo, 'docs/file.txt'), 'unselected modification\n')
    await writeFile(path.join(repo, 'docs\\file.txt'), 'selected modification\n')

    await commands.discardRuntimeGitPath('id:wt-1', 'docs\\file.txt')

    expect(await readFile(path.join(repo, 'docs\\file.txt'), 'utf8')).toBe('committed\n')
    expect(await readFile(path.join(repo, 'docs/file.txt'), 'utf8')).toBe(
      'unselected modification\n'
    )
  })
})
