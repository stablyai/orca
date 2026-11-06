import { detectConflictOperation } from './source-control/git-conflict-operation'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installRealWorkerThreadChildProcesses } from '../worker-thread-child-process/worker-thread-child-process-real.test-fixtures'
import { applyCommit, recoverSequencer } from './commit-actions'
import type { GitCommitAction } from '../../shared/git/commands/git-commit-action'

let directory: string
let topic: string
async function git(...args: string[]): Promise<string> {
  const result = await runProcess({ program: 'git', args, cwd: directory })
  if (result.code !== 0) {
    throw new Error(result.stderr)
  }
  return result.stdout.trim()
}
async function commit(text: string, message: string) {
  await writeFile(join(directory, 'file.txt'), text)
  await git('add', 'file.txt')
  await git('commit', '-qm', message)
  return git('rev-parse', 'HEAD')
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-commit-actions-'))
  await git('init', '-q')
  await git('symbolic-ref', 'HEAD', 'refs/heads/main')
  await git('config', 'user.name', 'Audit')
  await git('config', 'user.email', 'audit@example.test')
  await git('config', 'commit.gpgsign', 'false')
  await git('config', 'core.hooksPath', '')
  await commit('base\n', 'base')
  await git('checkout', '-qb', 'topic')
  topic = await commit('topic\n', 'topic change')
  await git('checkout', '-q', 'main')
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('commit actions', () => {
  it('cherry-picks onto the current branch without opening an editor', async () => {
    const result = await applyCommit(directory, 'cherry-pick', topic)
    expect(result).toMatchObject({ outcome: 'landed', branch: 'main' })
    expect(await git('show', 'HEAD:file.txt')).toBe('topic')
    expect(await git('log', '-1', '--format=%s')).toBe('topic change')
  })
  it('reverts a commit without opening an editor', async () => {
    await git('cherry-pick', topic)
    const result = await applyCommit(directory, 'revert', await git('rev-parse', 'HEAD'))
    expect(result).toMatchObject({ outcome: 'landed', branch: 'main' })
    expect(await git('show', 'HEAD:file.txt')).toBe('base')
    expect(await git('log', '-1', '--format=%s')).toBe('Revert "topic change"')
  })
  it('aborts an empty cherry-pick and leaves no operation in progress', async () => {
    await git('cherry-pick', topic)
    expect(await applyCommit(directory, 'cherry-pick', topic)).toEqual({
      outcome: 'empty',
      message: 'Already applied, nothing to cherry-pick'
    })
    await expect(git('rev-parse', '--verify', 'CHERRY_PICK_HEAD')).rejects.toThrow()
    expect(await git('status', '--porcelain')).toBe('')
  })
  for (const operation of ['cherry-pick', 'revert'] as const satisfies readonly GitCommitAction[]) {
    it(`${operation} leaves a dirty checkout untouched`, async () => {
      await writeFile(join(directory, 'file.txt'), 'uncommitted\n')
      const result = await applyCommit(directory, operation, topic)
      expect(result.outcome).toBe('refused')
      expect(await git('diff', '--', 'file.txt')).toContain('+uncommitted')
      expect(await git('log', '-1', '--format=%s')).toBe('base')
    })
    it(`${operation} preserves conflicts for recovery`, async () => {
      await commit('different\n', 'diverged')
      expect(await applyCommit(directory, operation, topic)).toEqual({ outcome: 'conflicted' })
      expect(await git('diff', '--name-only', '--diff-filter=U')).toBe('file.txt')
    })
    it(`${operation} can be aborted after a conflict, rejecting the wrong operation`, async () => {
      await commit('different\n', 'diverged')
      await applyCommit(directory, operation, topic)
      expect(await detectConflictOperation(directory)).toBe(operation)
      await expect(
        recoverSequencer(directory, operation === 'revert' ? 'cherry-pick' : 'revert', 'abort')
      ).rejects.toThrow('in progress')
      await recoverSequencer(directory, operation, 'abort')
      expect(await detectConflictOperation(directory)).toBe('unknown')
      expect(await git('show', 'HEAD:file.txt')).toBe('different')
      expect(await git('status', '--porcelain')).toBe('')
    })
    it(`${operation} continues a resolution even with a failing configured editor`, async () => {
      await commit('different\n', 'diverged')
      await applyCommit(directory, operation, topic)
      await writeFile(join(directory, 'file.txt'), 'resolved\n')
      await git('add', 'file.txt')
      const editor = process.env.GIT_EDITOR
      process.env.GIT_EDITOR = 'false'
      try {
        await recoverSequencer(directory, operation, 'continue')
      } finally {
        if (editor === undefined) {
          delete process.env.GIT_EDITOR
        } else {
          process.env.GIT_EDITOR = editor
        }
      }
      expect(await detectConflictOperation(directory)).toBe('unknown')
      expect(await git('show', 'HEAD:file.txt')).toBe('resolved')
      expect(await git('status', '--porcelain')).toBe('')
    })
    it(`${operation} refuses a merge commit using its actual parents`, async () => {
      await git('checkout', '-qb', 'other')
      await writeFile(join(directory, 'other.txt'), 'other\n')
      await git('add', 'other.txt')
      await git('commit', '-qm', 'other')
      await git('checkout', '-q', 'topic')
      await git('merge', '--no-ff', '--no-edit', 'other')
      const merge = await git('rev-parse', 'HEAD')
      await git('checkout', '-q', 'main')
      expect(await applyCommit(directory, operation, merge)).toEqual({
        outcome: 'refused',
        message: `Can't ${operation} a merge commit from here`
      })
      expect(await git('log', '-1', '--format=%s')).toBe('base')
    })
  }
})
installRealWorkerThreadChildProcesses()
