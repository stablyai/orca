import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mergeNgitPullRequest } from './pull-request-merge'
import type { ProjectedWorkItem } from './work-item-projection'

let root: string
let repo: string
let remote: string
let statuses: string[]
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd })
    .toString()
    .trim()

function commit(file: string, text: string): string {
  writeFileSync(join(repo, file), text)
  git(repo, 'add', file)
  git(repo, 'commit', '-m', file)
  return git(repo, 'rev-parse', 'HEAD')
}

beforeEach(() => {
  statuses = []
  root = mkdtempSync(join(tmpdir(), 'ngit-merge-test-'))
  remote = join(root, 'remote.git')
  repo = join(root, 'repo')
  git(root, 'init', '--bare', '-b', 'main', remote)
  git(root, 'clone', remote, repo)
  git(repo, 'checkout', '-b', 'main')
  git(repo, 'config', 'user.name', 't')
  git(repo, 'config', 'user.email', 't@t')
  commit('file', 'base')
  git(repo, 'push', 'origin', 'main')
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

function pull(headSha: string): ProjectedWorkItem {
  // Only these fields steer a merge.
  const item = {
    eventId: 'ab'.repeat(32),
    title: 'x',
    headSha,
    baseRefName: 'main',
    isPatch: false
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the merge reads nothing else.
  return { item, cloneUrls: [] } as unknown as ProjectedWorkItem
}

/** Stands in for `ngit pr merge`: a no-ff merge of the tip into the checked-out target. */
const fakeNgit = (tip: string) => async (args: string[], cwd: string) => {
  if (args.includes('applied')) {
    statuses.push(args[3])
    return '{}'
  }
  try {
    git(cwd, 'merge', '--no-ff', '-m', 'merge', tip)
  } catch {
    return '{"action":"conflicted"}'
  }
  return '{}'
}

describe('merging an ngit pull request', () => {
  it('pushes the merge without moving the checkout the user is on', async () => {
    git(repo, 'checkout', '-b', 'feature')
    const tip = commit('added', 'new')

    await expect(
      mergeNgitPullRequest(repo, pull(tip), 'origin', {}, fakeNgit(tip))
    ).resolves.toEqual({ ok: true })

    expect(git(remote, 'rev-parse', 'main^2')).toBe(tip)
    expect(git(repo, 'branch', '--show-current')).toBe('feature')
    expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(1)
    expect(statuses).toEqual(['applied'])
  })

  it('only publishes the status for changes already on the target', async () => {
    const tip = commit('added', 'new')
    git(repo, 'push', 'origin', 'main')
    const landed = git(remote, 'rev-parse', 'main')

    await expect(
      mergeNgitPullRequest(repo, pull(tip), 'origin', {}, fakeNgit(tip))
    ).resolves.toEqual({ ok: true })

    expect(git(remote, 'rev-parse', 'main')).toBe(landed)
    expect(statuses).toEqual(['applied'])
  })

  it('publishes nothing when the merge conflicts', async () => {
    git(repo, 'checkout', '-b', 'feature')
    const tip = commit('file', 'theirs')
    git(repo, 'checkout', 'main')
    commit('file', 'ours')
    git(repo, 'push', 'origin', 'main')
    const published = git(remote, 'rev-parse', 'main')

    const result = await mergeNgitPullRequest(repo, pull(tip), 'origin', {}, fakeNgit(tip))

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('conflicts') })
    expect(git(remote, 'rev-parse', 'main')).toBe(published)
    expect(git(repo, 'status', '--porcelain')).toBe('')
    expect(statuses).toEqual([])
  })

  it('refuses to publish local commits the remote does not have', async () => {
    git(repo, 'checkout', '-b', 'feature')
    const tip = commit('added', 'new')
    git(repo, 'checkout', 'main')
    commit('unpushed', 'private')
    const published = git(remote, 'rev-parse', 'main')

    const result = await mergeNgitPullRequest(repo, pull(tip), 'origin', {}, fakeNgit(tip))

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('does not') })
    expect(git(remote, 'rev-parse', 'main')).toBe(published)
  })
})
