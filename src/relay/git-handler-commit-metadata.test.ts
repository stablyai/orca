import { unlink, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runProcess } from '@orca/process-host'
import { commitCompare } from './git-handler-commit-diff-ops'
import type { GitExec } from './git-handler-ops'
import { gitCommit, gitInit } from './git-handler-test-setup'
import { createGitTempDir, removeGitTempDir } from './git-handler-test-harness'

describe('relay commit metadata resolution', () => {
  let repo: string
  let git: ReturnType<typeof vi.fn<GitExec>>

  beforeEach(async () => {
    repo = createGitTempDir()
    gitInit(repo)
    await writeFile(path.join(repo, 'file.txt'), 'root\n')
    gitCommit(repo, 'root')
    git = vi.fn<GitExec>(async (args, cwd) => {
      const result = await runProcess({ program: 'git', args, cwd })
      if (result.code !== 0) {
        throw new Error(result.stderr)
      }
      return { stdout: result.stdout, stderr: result.stderr }
    })
  })

  afterEach(async () => {
    await removeGitTempDir(repo)
  })

  async function oid(ref: string): Promise<string> {
    return (await git(['rev-parse', ref], repo)).stdout.trim()
  }

  async function nextCommit(): Promise<{ parent: string; commit: string }> {
    const parent = await oid('HEAD')
    await writeFile(path.join(repo, 'file.txt'), 'child\n')
    gitCommit(repo, 'child')
    return { parent, commit: await oid('HEAD') }
  }

  it('resolves a root commit and loads its changes in two Git calls', async () => {
    const commit = await oid('HEAD')
    git.mockClear()

    const result = await commitCompare(git, repo, commit)

    expect(result.summary).toMatchObject({ status: 'ready', commitOid: commit, parentOid: null })
    expect(result.entries).toEqual([{ path: 'file.txt', status: 'added', added: 1, removed: 0 }])
    expect(git).toHaveBeenCalledTimes(2)
  })

  it('peels an annotated tag object id while retaining its first commit parent', async () => {
    const { commit, parent } = await nextCommit()
    await git(['tag', '-a', 'test-tag', '-m', 'annotated'], repo)
    const tag = await oid('test-tag')
    expect(tag).not.toBe(commit)
    git.mockClear()

    const result = await commitCompare(git, repo, tag)

    expect(result.summary).toMatchObject({ status: 'ready', commitOid: commit, parentOid: parent })
    expect(git).toHaveBeenCalledTimes(2)
  })

  it('honors the shallow boundary rather than exposing an unavailable raw parent', async () => {
    const { commit } = await nextCommit()
    await writeFile(path.join(repo, '.git', 'shallow'), `${commit}\n`)

    const result = await commitCompare(git, repo, commit)

    expect(result.summary).toMatchObject({ status: 'ready', commitOid: commit, parentOid: null })
  })

  it('preserves the resolved commit when reading a missing parent fails', async () => {
    const { commit, parent } = await nextCommit()
    await unlink(path.join(repo, '.git', 'objects', parent.slice(0, 2), parent.slice(2)))
    git.mockClear()

    const result = await commitCompare(git, repo, commit)

    expect(result.summary).toMatchObject({ status: 'error', commitOid: commit })
    expect(result.entries).toEqual([])
    expect(git.mock.calls.map(([args]) => args[0])).toEqual(['rev-list', 'rev-parse'])
  })

  it('distinguishes a blob object from a valid commit', async () => {
    const blob = await oid('HEAD:file.txt')

    const result = await commitCompare(git, repo, blob)

    expect(result.summary).toMatchObject({ status: 'invalid-commit', commitOid: '' })
  })

  it('rejects arbitrary revision expressions before executing Git', async () => {
    git.mockClear()
    await expect(commitCompare(git, repo, 'HEAD~1..HEAD')).rejects.toThrow('full git object id')
    expect(git).not.toHaveBeenCalled()
  })
})
