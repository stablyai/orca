import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { gitInit, gitCommit, type MockDispatcher } from './git-handler-test-setup'
import {
  createGitHandlerRelay,
  createGitTempDir,
  removeGitTempDir
} from './git-handler-test-harness'
import type { GitHandler } from './git-handler'
import { GIT_BLAME_INDEX_CONTENTS, isUncommittedBlameOid } from '../shared/git-blame'

describe('GitHandler blame', () => {
  let dispatcher: MockDispatcher
  let handler: GitHandler
  let tmpDir: string

  beforeEach(() => {
    tmpDir = createGitTempDir()
    ;({ dispatcher, handler } = createGitHandlerRelay())
  })

  afterEach(async () => {
    handler.dispose()
    await removeGitTempDir(tmpDir)
  })

  it('rejects blame paths that traverse outside the worktree', async () => {
    gitInit(tmpDir)

    await expect(
      dispatcher.callRequest('git.blame', {
        worktreePath: tmpDir,
        filePath: '../outside.txt'
      })
    ).rejects.toThrow('outside the worktree')
  })

  it('rejects a flag-like blame revision before git runs', async () => {
    gitInit(tmpDir)

    await expect(
      dispatcher.callRequest('git.blame', {
        worktreePath: tmpDir,
        filePath: 'note.txt',
        revision: '--output=/tmp/pwned'
      })
    ).rejects.toThrow('revision must be a full git object id')
  })

  it('blames staged index contents when they differ from the working tree', async () => {
    gitInit(tmpDir)
    writeFileSync(`${tmpDir}/note.txt`, 'hello\n')
    gitCommit(tmpDir, 'Add note')
    writeFileSync(`${tmpDir}/note.txt`, 'hello\nstaged\n')
    execFileSync('git', ['add', 'note.txt'], { cwd: tmpDir, stdio: 'pipe' })
    writeFileSync(`${tmpDir}/note.txt`, 'hello\nstaged\nworktree\n')

    const workingTree = (await dispatcher.callRequest('git.blame', {
      worktreePath: tmpDir,
      filePath: 'note.txt'
    })) as { status: string; lines: { commitOid: string }[] }
    expect(workingTree.status).toBe('ready')
    expect(workingTree.lines).toHaveLength(3)
    expect(isUncommittedBlameOid(workingTree.lines[2]?.commitOid ?? '')).toBe(true)

    const index = (await dispatcher.callRequest('git.blame', {
      worktreePath: tmpDir,
      filePath: 'note.txt',
      contentsSource: GIT_BLAME_INDEX_CONTENTS
    })) as { status: string; lines: { commitOid: string }[] }
    expect(index.status).toBe('ready')
    expect(index.lines).toHaveLength(2)
    expect(isUncommittedBlameOid(index.lines[1]?.commitOid ?? '')).toBe(true)
  })

  it('streams a blame reply that exceeds the control-lane frame budget', async () => {
    gitInit(tmpDir)
    const body = Array.from({ length: 4000 }, (_, i) => `line ${i}`).join('\n')
    writeFileSync(`${tmpDir}/big.txt`, `${body}\n`)
    gitCommit(tmpDir, 'Add big file')
    ;(dispatcher as unknown as { notifyBulk: unknown }).notifyBulk = vi
      .fn()
      .mockResolvedValue(undefined)
    const params = { worktreePath: tmpDir, filePath: 'big.txt' }
    const context = { clientId: 1, isStale: () => false }

    const plain = (await dispatcher.callRequest('git.blame', params, context)) as {
      lines: unknown[]
    }
    expect(plain.lines).toHaveLength(4000)

    const streamed = await dispatcher.callRequest(
      'git.blame',
      { ...params, __streamResponse: true },
      context
    )
    expect(streamed).toHaveProperty('__orcaGitResponseStream')
  })
})
