import './create-branch'
import { detectConflictOperation } from '../../source-control/git-conflict-operation'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installRealWorkerThreadChildProcesses } from '../../../worker-thread-child-process/worker-thread-child-process-real.test-fixtures'
import { applyCommit, recoverSequencer } from './commit-actions'
import type { GitCommitAction } from '../../../../shared/git/commands/git-commit-action'

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

  for (const operation of ['cherry-pick', 'revert'] as const satisfies readonly GitCommitAction[]) {
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
  }
})
installRealWorkerThreadChildProcesses()
