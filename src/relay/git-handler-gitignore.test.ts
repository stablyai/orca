import { mkdtempSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RelayContext } from './context'
import { GitHandler } from './git-handler'
import {
  createMockDispatcher,
  type MockDispatcher,
  type RelayDispatcher
} from './git-handler-test-setup'

describe('GitHandler gitignore', () => {
  let dispatcher: MockDispatcher
  let handler: GitHandler
  let worktreePath: string

  beforeEach(() => {
    worktreePath = mkdtempSync(path.join(tmpdir(), 'relay-gitignore-'))
    dispatcher = createMockDispatcher()
    handler = new GitHandler(dispatcher as unknown as RelayDispatcher, new RelayContext())
  })

  afterEach(async () => {
    handler.dispose()
    await fs.rm(worktreePath, { recursive: true, force: true })
  })

  it('appends and deduplicates entries on the relay host', async () => {
    await fs.writeFile(path.join(worktreePath, '.gitignore'), 'coverage/\n')
    const entries = [
      { relativePath: 'coverage', isDirectory: true },
      { relativePath: 'dist', isDirectory: true }
    ]

    const result = await dispatcher.callRequest('git.appendGitignoreEntries', {
      worktreePath,
      entries
    })

    expect(result).toEqual({ added: ['dist'], alreadyPresent: ['coverage'] })
    await expect(fs.readFile(path.join(worktreePath, '.gitignore'), 'utf8')).resolves.toBe(
      'coverage/\ndist/\n'
    )
  })

  it.runIf(process.platform !== 'win32')('rejects a symlinked relay .gitignore', async () => {
    const outsidePath = path.join(worktreePath, 'outside.txt')
    await fs.writeFile(outsidePath, 'keep\n')
    await fs.symlink(outsidePath, path.join(worktreePath, '.gitignore'))

    await expect(
      dispatcher.callRequest('git.appendGitignoreEntries', {
        worktreePath,
        entries: [{ relativePath: 'dist', isDirectory: true }]
      })
    ).rejects.toThrow(/symbolic-link/)
    await expect(fs.readFile(outsidePath, 'utf8')).resolves.toBe('keep\n')
  })
})
