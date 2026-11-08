import { createBranch } from './create-branch'
import { detectConflictOperation } from './source-control/git-conflict-operation'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
  vi.unstubAllEnvs()
  await rm(directory, { recursive: true, force: true })
})

describe('commit actions', () => {
  it('creates a branch at the selected commit without switching HEAD or enabling tracking', async () => {
    await git('config', 'branch.autoSetupMerge', 'always')
    expect(await createBranch(directory, 'saved-topic', topic)).toEqual({
      outcome: 'landed',
      branch: 'saved-topic',
      commitId: topic
    })
    expect(await git('rev-parse', 'saved-topic')).toBe(topic)
    expect(await git('branch', '--show-current')).toBe('main')
    expect(await git('for-each-ref', '--format=%(upstream)', 'refs/heads/saved-topic')).toBe('')
    await expect(createBranch(directory, '@', topic)).rejects.toThrow(
      'This branch name is invalid. Choose a different name.'
    )
    expect(await git('branch', '--show-current')).toBe('main')
  })

  it('cherry-picks a root commit onto a clean unborn branch', async () => {
    const root = await git('rev-list', '--max-parents=0', 'HEAD')
    await git('checkout', '--orphan', 'unborn')
    await git('rm', '-rf', '.')
    expect(await applyCommit(directory, 'cherry-pick', root)).toMatchObject({
      outcome: 'landed',
      branch: 'unborn'
    })
    expect(await git('show', 'HEAD:file.txt')).toBe('base')
    expect(await git('log', '-1', '--format=%s')).toBe('base')
  })
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
  it('aborts a cherry-pick that becomes empty when continuing a conflict resolution', async () => {
    await commit('different\n', 'diverged')
    await applyCommit(directory, 'cherry-pick', topic)
    await writeFile(join(directory, 'file.txt'), 'different\n')
    await git('add', 'file.txt')
    expect(await recoverSequencer(directory, 'cherry-pick', 'continue')).toEqual({
      outcome: 'empty',
      message: 'Already applied, nothing to cherry-pick'
    })
    expect(await detectConflictOperation(directory)).toBe('unknown')
    expect(await git('log', '-1', '--format=%s')).toBe('diverged')
    expect(await git('status', '--porcelain')).toBe('')
  })
  for (const inProgress of ['merge', 'rebase', 'cherry-pick', 'revert', 'stash'] as const) {
    it(`refuses both commit actions during an existing ${inProgress} conflict`, async () => {
      if (inProgress === 'stash') {
        await writeFile(join(directory, 'file.txt'), 'stashed\n')
        await git('stash', 'push', '-m', 'saved changes')
      }
      await commit('different\n', 'diverged')
      await expect(
        inProgress === 'stash' ? git('stash', 'pop') : git(inProgress, topic)
      ).rejects.toThrow()
      for (const operation of ['cherry-pick', 'revert'] as const) {
        expect(await applyCommit(directory, operation, topic)).toEqual({
          outcome: 'refused',
          message:
            inProgress === 'stash'
              ? 'Git did not create a commit. Check the checkout and try again.'
              : `Finish or abort the ${inProgress} in progress before trying again.`
        })
      }
      expect(await detectConflictOperation(directory)).toBe(
        inProgress === 'stash' ? 'unknown' : inProgress
      )
      expect(await git('diff', '--name-only', '--diff-filter=U')).toBe('file.txt')
    })
  }
  for (const operation of ['cherry-pick', 'revert'] as const satisfies readonly GitCommitAction[]) {
    it(`${operation} leaves a dirty checkout untouched`, async () => {
      if (operation === 'revert') {
        await git('cherry-pick', topic)
      }
      await writeFile(join(directory, 'file.txt'), 'uncommitted\n')
      const result = await applyCommit(directory, operation, topic)
      expect(result).toEqual({
        outcome: 'refused',
        message: 'Commit or stash your changes, then try again.'
      })
      expect(await git('diff', '--', 'file.txt')).toContain('+uncommitted')
      expect(await git('log', '-1', '--format=%s')).toBe(
        operation === 'revert' ? 'topic change' : 'base'
      )
    })
    it(`${operation} can be aborted after a conflict, rejecting the wrong operation`, async () => {
      await commit('different\n', 'diverged')
      expect(await applyCommit(directory, operation, topic)).toEqual({ outcome: 'conflicted' })
      expect(await git('diff', '--name-only', '--diff-filter=U')).toBe('file.txt')
      expect(await detectConflictOperation(directory)).toBe(operation)
      await expect(
        recoverSequencer(directory, operation === 'revert' ? 'cherry-pick' : 'revert', 'abort')
      ).rejects.toThrow('in progress')
      await recoverSequencer(directory, operation, 'abort')
      expect(await detectConflictOperation(directory)).toBe('unknown')
      expect(await git('show', 'HEAD:file.txt')).toBe('different')
      expect(await git('status', '--porcelain')).toBe('')
    })
    it(`${operation} continues with identity only in HOME and a failing configured editor`, async () => {
      await commit('different\n', 'diverged')
      await applyCommit(directory, operation, topic)
      await writeFile(join(directory, 'file.txt'), 'resolved\n')
      await git('add', 'file.txt')
      const home = join(directory, '.git', 'test-home')
      await mkdir(home)
      await writeFile(
        join(home, '.gitconfig'),
        '[user]\nname = Home Identity\nemail = home@example.test\n'
      )
      await git('config', '--unset', 'user.name')
      await git('config', '--unset', 'user.email')
      vi.stubEnv('HOME', home)
      vi.stubEnv('USERPROFILE', home)
      vi.stubEnv('XDG_CONFIG_HOME', home)
      vi.stubEnv('GIT_CONFIG_GLOBAL', undefined)
      vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
      vi.stubEnv('GIT_EDITOR', 'false')
      for (const key of [
        'GIT_AUTHOR_NAME',
        'GIT_AUTHOR_EMAIL',
        'GIT_COMMITTER_NAME',
        'GIT_COMMITTER_EMAIL'
      ]) {
        vi.stubEnv(key, undefined)
      }
      await recoverSequencer(directory, operation, 'continue')
      expect(await detectConflictOperation(directory)).toBe('unknown')
      expect(await git('show', 'HEAD:file.txt')).toBe('resolved')
      expect(await git('status', '--porcelain')).toBe('')
      expect(await git('log', '-1', '--format=%cn <%ce>')).toBe('Home Identity <home@example.test>')
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
