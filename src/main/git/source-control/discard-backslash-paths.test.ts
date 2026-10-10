import { mkdir, readFile, writeFile } from 'node:fs/promises'
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
import { bulkDiscardChanges } from './discard-changes'

// Windows filenames cannot contain literal backslashes.
describe.skipIf(process.platform === 'win32')('bulk discard preserves POSIX path identity', () => {
  let repo: string
  let dispatcher: MockDispatcher
  let handler: GitHandler

  beforeEach(() => {
    repo = createGitTempDir()
    ;({ dispatcher, handler } = createGitHandlerRelay())
    gitInit(repo)
  })

  afterEach(async () => {
    handler.dispose()
    await removeGitTempDir(repo)
  })

  async function git(args: string[]): Promise<string> {
    const result = await runProcess({ program: 'git', args, cwd: repo })
    expect(result.code, result.stderr).toBe(0)
    return result.stdout
  }

  for (const host of ['native', 'relay'] as const) {
    it.each([
      { tracked: 'docs/file.txt', untracked: 'docs\\file.txt', untrackedFile: 'docs\\file.txt' },
      { tracked: 'docs\\file.txt', untracked: 'docs/file.txt', untrackedFile: 'docs/file.txt' },
      { tracked: 'docs\\file.txt', untracked: 'docs', untrackedFile: 'docs/scratch.txt' }
    ])(`discards $untracked separately from tracked $tracked on ${host}`, async (fixture) => {
      const trackedFile = path.join(repo, fixture.tracked)
      await mkdir(path.dirname(trackedFile), { recursive: true })
      await writeFile(trackedFile, 'committed\n')
      gitCommit(repo, 'initial')
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
        : dispatcher.callRequest('git.bulkDiscard', { worktreePath: repo, filePaths }))

      expect(await readFile(trackedFile, 'utf8')).toBe('staged\n')
      expect(await git(['show', `:${fixture.tracked}`])).toBe('staged\n')
      await expect(readFile(untrackedFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readFile(path.join(repo, 'leave.txt'), 'utf8')).toBe('unselected\n')
    })
  }
})
