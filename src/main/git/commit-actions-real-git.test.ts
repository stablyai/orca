import { createBranch } from './create-branch'
import { detectConflictOperation } from './source-control/git-conflict-operation'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
  it('skips an empty graph cherry-pick while preserving unrelated unstaged edits', async () => {
    await writeFile(join(directory, 'unrelated.txt'), 'original\n')
    await git('add', 'unrelated.txt')
    await git('commit', '-qm', 'unrelated file')
    await git('cherry-pick', topic)
    await writeFile(join(directory, 'unrelated.txt'), 'work in progress\n')
    expect(await applyCommit(directory, 'cherry-pick', topic)).toEqual({
      outcome: 'empty',
      message: 'Already applied, nothing to cherry-pick'
    })
    await expect(git('rev-parse', '--verify', 'CHERRY_PICK_HEAD')).rejects.toThrow()
    expect(await git('log', '--format=%s')).toBe('topic change\nunrelated file\nbase')
    expect(await git('show', 'HEAD:file.txt')).toBe('topic')
    expect(await git('diff', '--', 'unrelated.txt')).toContain('+work in progress')
    expect(await git('status', '--porcelain')).toBe('M unrelated.txt')
  })
  it.each([
    ['cherry-pick', 'Already applied, nothing to cherry-pick', 'CHERRY_PICK_HEAD'],
    ['revert', 'Nothing to revert; the changes are already undone.', 'REVERT_HEAD']
  ] as const)(
    'finishes an empty %s conflict resolution',
    async (operation, message, operationHead) => {
      await commit('different\n', 'diverged')
      expect(await applyCommit(directory, operation, topic)).toEqual({ outcome: 'conflicted' })
      await writeFile(join(directory, 'file.txt'), 'different\n')
      await git('add', 'file.txt')
      if (operation === 'revert') {
        await writeFile(join(directory, 'untracked.txt'), 'keep me\n')
      }
      expect(await recoverSequencer(directory, operation, 'continue')).toEqual({
        outcome: 'empty',
        message
      })
      expect(await detectConflictOperation(directory)).toBe('unknown')
      await expect(git('rev-parse', '--verify', operationHead)).rejects.toThrow()
      expect(await git('log', '-1', '--format=%s')).toBe('diverged')
      expect(await git('status', '--porcelain')).toBe(
        operation === 'revert' ? '?? untracked.txt' : ''
      )
    }
  )
  it('skips an empty final cherry-pick while preserving earlier picks and unrelated unstaged edits', async () => {
    await git('checkout', '-q', 'topic')
    await writeFile(join(directory, 'first.txt'), 'first\n')
    await git('add', 'first.txt')
    await git('commit', '-qm', 'first pick')
    const first = await git('rev-parse', 'HEAD')
    await writeFile(join(directory, 'second.txt'), 'second\n')
    await git('add', 'second.txt')
    await git('commit', '-qm', 'second pick')
    const last = await commit('last\n', 'last pick')
    await git('checkout', '-q', 'main')
    await writeFile(join(directory, 'unrelated.txt'), 'original\n')
    await git('add', 'unrelated.txt')
    await commit('different\n', 'diverged')
    await expect(git('cherry-pick', `${first}^..${last}`)).rejects.toThrow()
    await writeFile(join(directory, 'file.txt'), 'different\n')
    await git('add', 'file.txt')
    await writeFile(join(directory, 'unrelated.txt'), 'work in progress\n')

    expect(await recoverSequencer(directory, 'cherry-pick', 'continue')).toEqual({
      outcome: 'empty',
      message: 'Already applied, nothing to cherry-pick'
    })
    expect(await git('log', '--format=%s')).toBe('second pick\nfirst pick\ndiverged\nbase')
    expect(await git('show', 'HEAD:first.txt')).toBe('first')
    expect(await git('show', 'HEAD:second.txt')).toBe('second')
    expect(await git('show', 'HEAD:file.txt')).toBe('different')
    await expect(git('rev-parse', '--verify', 'CHERRY_PICK_HEAD')).rejects.toThrow()
    expect(await git('diff', '--', 'unrelated.txt')).toContain('+work in progress')
    expect(await git('status', '--porcelain')).toBe('M unrelated.txt')
  })
  it('uses the recorded merge mainline without blocking unrelated work from the other parent', async () => {
    await git('merge', '--no-ff', '-s', 'ours', '--no-edit', 'topic')
    const merge = await git('rev-parse', 'HEAD')
    const base = await git('rev-parse', 'HEAD^1')
    await git('checkout', '-qb', 'pick-source', base)
    await writeFile(join(directory, 'picked.txt'), 'picked\n')
    await git('add', 'picked.txt')
    await git('commit', '-qm', 'first pick')
    const first = await git('rev-parse', 'HEAD')
    await git('checkout', '-qb', 'destination', base)
    await writeFile(join(directory, 'file.txt'), 'work in progress\n')
    await expect(git('cherry-pick', '-m', '1', first, merge)).rejects.toThrow()

    expect(await recoverSequencer(directory, 'cherry-pick', 'continue')).toEqual({
      outcome: 'empty',
      message: 'Already applied, nothing to cherry-pick'
    })
    expect(await git('log', '--format=%s')).toBe('first pick\nbase')
    expect(await git('show', 'HEAD:picked.txt')).toBe('picked')
    expect(await git('diff', '--', 'file.txt')).toContain('+work in progress')
    expect(await git('status', '--porcelain')).toBe('M file.txt')
    await expect(git('rev-parse', '--verify', 'CHERRY_PICK_HEAD')).rejects.toThrow()
    expect(await detectConflictOperation(directory)).toBe('unknown')
  })
  it('keeps a conflicting revert whose subject contains nothing to commit in progress', async () => {
    await git('checkout', '-q', 'topic')
    await git('commit', '--amend', '-qm', 'Fix nothing to commit warning')
    topic = await git('rev-parse', 'HEAD')
    await git('checkout', '-q', 'main')
    await commit('different\n', 'diverged')

    expect(await applyCommit(directory, 'revert', topic)).toEqual({ outcome: 'conflicted' })
    await expect(recoverSequencer(directory, 'revert', 'continue')).rejects.toThrow(/^error: /)
    expect(await git('rev-parse', '--verify', 'REVERT_HEAD')).toBe(topic)
    expect(await git('diff', '--name-only', '--diff-filter=U')).toBe('file.txt')
    expect(await git('log', '-1', '--format=%s')).toBe('diverged')
  })
  it('preserves a staged gitlink when Continue fails with submodule diffs configured off', async () => {
    await git('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', directory, 'module')
    await git('commit', '-qm', 'add module')
    await git('checkout', '-qb', 'module-topic')
    await git('-C', 'module', 'checkout', '-q', topic)
    await git('add', 'module')
    await git('commit', '-qm', 'topic module link')
    const target = await git('rev-parse', 'HEAD')
    await git('checkout', '-q', 'main')
    await git('-C', 'module', 'checkout', '-qb', 'other-link', 'origin/main')
    await writeFile(join(directory, 'module', 'file.txt'), 'other module\n')
    await git(
      '-C',
      'module',
      '-c',
      'user.name=Audit',
      '-c',
      'user.email=audit@example.test',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=',
      'commit',
      '-qam',
      'other module'
    )
    await git('add', 'module')
    await git('commit', '-qm', 'other module link')
    expect(await applyCommit(directory, 'cherry-pick', target)).toEqual({ outcome: 'conflicted' })
    await git('-C', 'module', 'checkout', '-q', topic)
    await git('add', 'module')
    await git('config', 'diff.ignoreSubmodules', 'all')
    const hooks = join(directory, '.git', 'hooks')
    await git('config', 'core.hooksPath', hooks)
    await writeFile(
      join(hooks, 'pre-commit'),
      '#!/bin/sh\necho "error: reject gitlink" >&2\nexit 1\n'
    )
    await chmod(join(hooks, 'pre-commit'), 0o755)

    await expect(recoverSequencer(directory, 'cherry-pick', 'continue')).rejects.toThrow(
      'error: reject gitlink'
    )
    expect(await git('rev-parse', '--verify', 'CHERRY_PICK_HEAD')).toBe(target)
    expect(await git('diff', '--cached', '--name-only', '--ignore-submodules=none')).toBe('module')
    expect(await git('rev-parse', ':module')).toBe(topic)
    expect(await git('log', '-1', '--format=%s')).toBe('other module link')
  })
  it('keeps an unstaged resolution in progress instead of reporting an empty cherry-pick', async () => {
    await commit('different\n', 'diverged')
    expect(await applyCommit(directory, 'cherry-pick', topic)).toEqual({ outcome: 'conflicted' })
    await writeFile(join(directory, 'file.txt'), 'resolved\n')
    await git('add', 'file.txt')
    await git('restore', '--staged', 'file.txt')

    await expect(recoverSequencer(directory, 'cherry-pick', 'continue')).rejects.toThrow()
    expect(await git('rev-parse', '--verify', 'CHERRY_PICK_HEAD')).toBe(topic)
    expect(await git('diff', '--', 'file.txt')).toContain('+resolved')
    expect(await git('status', '--porcelain')).toBe('M file.txt')
    expect(await git('log', '-1', '--format=%s')).toBe('diverged')
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
      await expect(recoverSequencer(directory, operation, 'continue')).rejects.toThrow(/^error: /)
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
