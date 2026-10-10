import { readFile, writeFile } from 'node:fs/promises'
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
import { bulkStageFiles, bulkUnstageFiles } from './staging'
import { bulkDiscardChanges } from './discard-changes'

describe('bulk pathspec stdin on execution hosts', () => {
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

  async function changedFiles(staged: boolean): Promise<string[]> {
    const result = await runProcess({
      program: 'git',
      args: ['diff', ...(staged ? ['--cached'] : []), '--name-only', '-z'],
      cwd: repo
    })
    expect(result.code).toBe(0)
    return result.stdout.split('\0').filter(Boolean).sort()
  }

  function mutate(
    host: 'native' | 'relay',
    action: 'stage' | 'unstage' | 'discard',
    filePaths: string[]
  ): Promise<unknown> {
    if (host === 'relay') {
      const methods = {
        stage: 'git.bulkStage',
        unstage: 'git.bulkUnstage',
        discard: 'git.bulkDiscard'
      }
      return dispatcher.callRequest(methods[action], { worktreePath: repo, filePaths })
    }
    const operations = {
      stage: bulkStageFiles,
      unstage: bulkUnstageFiles,
      discard: bulkDiscardChanges
    }
    return operations[action](repo, filePaths)
  }

  it.each(['native', 'relay'] as const)(
    'stages, unstages and discards over 100 literal paths on %s',
    async (host) => {
      const selected = Array.from({ length: 105 }, (_, index) => `file-${index}.txt`)
      selected.push('[k]eep.log', 'space name.txt', '-option.txt')
      if (process.platform !== 'win32') {
        selected.push('line\nname.txt', ':(magic).txt', 'back\\slash.txt')
      }
      const allPaths = [...selected, 'keep.log']
      await Promise.all(
        allPaths.map((filePath) => writeFile(path.join(repo, filePath), 'original\n'))
      )
      gitCommit(repo, 'initial')
      await Promise.all(
        allPaths.map((filePath) => writeFile(path.join(repo, filePath), 'modified\n'))
      )

      await mutate(host, 'stage', [])
      expect(await changedFiles(true)).toEqual([])
      await mutate(host, 'stage', selected)
      expect(await changedFiles(true)).toEqual([...selected].sort())
      await mutate(host, 'unstage', [])
      expect(await changedFiles(true)).toEqual([...selected].sort())
      await mutate(host, 'unstage', selected)
      expect(await changedFiles(true)).toEqual([])
      await mutate(host, 'discard', [])
      expect(await changedFiles(false)).toEqual([...allPaths].sort())
      await mutate(host, 'discard', selected)
      expect(await changedFiles(false)).toEqual(['keep.log'])
      expect(await readFile(path.join(repo, 'keep.log'), 'utf8')).toBe('modified\n')
    }
  )

  it.each(['native', 'relay'] as const)('rejects NUL path injection on %s', async (host) => {
    await writeFile(path.join(repo, 'one.txt'), 'original\n')
    gitCommit(repo, 'initial')
    await writeFile(path.join(repo, 'one.txt'), 'modified\n')

    await expect(mutate(host, 'stage', ['one.txt\0:(top)**'])).rejects.toThrow('NUL')
    expect(await changedFiles(true)).toEqual([])
  })
})
