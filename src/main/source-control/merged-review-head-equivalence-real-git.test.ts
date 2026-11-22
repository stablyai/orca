import { runProcessSync } from '@orca/process-host'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mergedReviewHeadIsEquivalent } from './merged-review-head-equivalence'
import { getLocalGitCapabilityCache } from '../git/command-runner/host-routing/git-capability-state'
import { isUnsupportedMergeTreeWriteTreeError } from '../../shared/git/branches/git-merge-tree-capability'

describe('merged review head equivalence (real Git)', () => {
  let repoPath = ''
  const gitWithInput = (args: string[], input?: string | Uint8Array, cwd = repoPath): string => {
    const result = runProcessSync({ program: 'git', args, cwd, input })
    if (result.code !== 0) {
      throw new Error(result.stderr)
    }
    return result.stdout.trim()
  }
  const git = (...args: string[]): string => gitWithInput(args)
  const commit = (file: string, content: string, message: string): string => {
    writeFileSync(join(repoPath, file), content)
    git('add', file)
    git('commit', '--quiet', '-m', message)
    return git('rev-parse', 'HEAD')
  }
  const prove = (reviewHeadOid: string, headOid: string, connectionId?: string) =>
    mergedReviewHeadIsEquivalent({
      repoPath,
      connectionId,
      localGitOptions: {},
      reviewHeadOid,
      baseBranchName: 'main',
      headOid
    })

  beforeEach(() => {
    repoPath = mkdtempSync(join(tmpdir(), 'orca-merged-review-equivalence-'))
    git('init', '--quiet')
    git('symbolic-ref', 'HEAD', 'refs/heads/main')
    git('config', 'user.name', 'Orca Test')
    git('config', 'user.email', 'orca@example.test')
    git('config', 'commit.gpgSign', 'false')
    git('config', 'core.hooksPath', '.git/no-hooks')
    commit('shared.txt', 'a\nb\nc\nd\ne\nf\n', 'base')
  })

  afterEach(() => {
    rmSync(repoPath, { recursive: true, force: true })
  })

  // Review edits line 1; main later edits line 6 of the same file, then the branch is rebased locally.
  function rebasedReview(reviewFile = 'shared.txt'): { reviewHead: string; rebasedHead: string } {
    git('checkout', '--quiet', '-b', 'feature')
    const reviewHead = commit(reviewFile, 'A\nb\nc\nd\ne\nf\n', 'review')
    git('checkout', '--quiet', 'main')
    commit('shared.txt', 'a\nb\nc\nd\ne\nF\n', 'upstream change')
    git('update-ref', 'refs/remotes/origin/main', 'HEAD')
    git('checkout', '--quiet', 'feature')
    git('rebase', '--quiet', 'origin/main')
    return { reviewHead, rebasedHead: git('rev-parse', 'HEAD') }
  }

  function shallowRebasedReview() {
    const { reviewHead, rebasedHead } = rebasedReview('feature.txt')
    git('branch', 'review', reviewHead)
    const shallowPath = join(repoPath, 'shallow')
    git('init', '--quiet', shallowPath)
    const fetch = (depth: string) =>
      gitWithInput(
        [
          'fetch',
          '--quiet',
          depth,
          pathToFileURL(repoPath).href,
          '+refs/heads/main:refs/remotes/origin/main',
          '+refs/heads/review:refs/remotes/origin/review',
          '+refs/heads/feature:refs/remotes/origin/feature'
        ],
        undefined,
        shallowPath
      )
    fetch('--depth=1')
    return {
      request: {
        repoPath: shallowPath,
        localGitOptions: {},
        reviewHeadOid: reviewHead,
        baseBranchName: 'main',
        headOid: rebasedHead
      },
      deepen: () => fetch('--unshallow')
    }
  }

  it('proves a rebase when main edited the same file on Git with write-tree support', async ({
    skip
  }) => {
    const { reviewHead, rebasedHead } = rebasedReview()
    try {
      git('merge-tree', '--write-tree', 'origin/main', reviewHead)
    } catch (error) {
      if (isUnsupportedMergeTreeWriteTreeError(error)) {
        skip()
      }
      throw error
    }
    await expect(prove(reviewHead, rebasedHead)).resolves.toBe(true)
  })

  it('proves a separate-file rebase through the older-Git exact-diff fallback', async () => {
    const { reviewHead, rebasedHead } = rebasedReview('feature.txt')
    const capabilities = getLocalGitCapabilityCache({ cwd: repoPath })
    capabilities.rememberUnsupported('merge-tree-write-tree')
    try {
      await expect(prove(reviewHead, rebasedHead)).resolves.toBe(true)
      const extraHead = commit('local.txt', 'unpushed\n', 'local work')
      await expect(prove(reviewHead, extraHead)).resolves.toBe(false)
    } finally {
      capabilities.clear()
    }
  })

  it('refuses distinct non-UTF-8 paths with identical blobs in the older-Git fallback', async () => {
    const base = git('rev-parse', 'HEAD')
    const blob = gitWithInput(['hash-object', '-w', '--stdin'], 'review content\n')
    const tree = (pathByte: number) =>
      gitWithInput(
        ['mktree', '-z'],
        Buffer.concat([Buffer.from(`100644 blob ${blob}\tpath-`), Buffer.from([pathByte, 0])])
      )
    const reviewHead = git('commit-tree', tree(0xff), '-p', base, '-m', 'review')
    const localHead = git('commit-tree', tree(0xfe), '-p', base, '-m', 'local rename')
    git('update-ref', 'refs/remotes/origin/main', base)
    const capabilities = getLocalGitCapabilityCache({ cwd: repoPath })
    capabilities.rememberUnsupported('merge-tree-write-tree')
    try {
      await expect(prove(reviewHead, localHead)).resolves.toBe(false)
    } finally {
      capabilities.clear()
    }
  })

  it('retries a same-commit proof after shallow history is deepened', async () => {
    const { request, deepen } = shallowRebasedReview()
    await expect(mergedReviewHeadIsEquivalent(request)).resolves.toBe(false)
    deepen()
    await expect(mergedReviewHeadIsEquivalent(request)).resolves.toBe(true)
  })

  it('retries a same-commit proof after deepening through the older-Git fallback', async () => {
    const { request, deepen } = shallowRebasedReview()
    const capabilities = getLocalGitCapabilityCache({ cwd: request.repoPath })
    capabilities.rememberUnsupported('merge-tree-write-tree')
    try {
      await expect(mergedReviewHeadIsEquivalent(request)).resolves.toBe(false)
      deepen()
      await expect(mergedReviewHeadIsEquivalent(request)).resolves.toBe(true)
    } finally {
      capabilities.clear()
    }
  })

  it('rechecks a cached proof after the remote base is rewritten', async () => {
    const { reviewHead, rebasedHead } = rebasedReview('feature.txt')
    await expect(prove(reviewHead, rebasedHead)).resolves.toBe(true)
    git('update-ref', 'refs/remotes/origin/main', 'main^')
    await expect(prove(reviewHead, rebasedHead)).resolves.toBe(false)
  })

  it('retries after a missing review commit becomes available', async () => {
    const { reviewHead, rebasedHead } = rebasedReview('feature.txt')
    const objectPath = join(
      repoPath,
      '.git',
      'objects',
      reviewHead.slice(0, 2),
      reviewHead.slice(2)
    )
    const object = readFileSync(objectPath)
    rmSync(objectPath)
    await expect(prove(reviewHead, rebasedHead)).resolves.toBe(false)
    writeFileSync(objectPath, object)
    await expect(prove(reviewHead, rebasedHead)).resolves.toBe(true)
  })

  it('refuses a rebased head that carries extra work', async () => {
    const { reviewHead } = rebasedReview()
    const extraHead = commit('local.txt', 'unpushed\n', 'local work')
    await expect(prove(reviewHead, extraHead)).resolves.toBe(false)
  })

  it('refuses a reused branch name whose head is just main with the review merged', async () => {
    git('checkout', '--quiet', '-b', 'feature')
    const reviewHead = commit('shared.txt', 'A\nb\nc\nd\ne\nf\n', 'review')
    git('checkout', '--quiet', 'main')
    git('merge', '--quiet', '--squash', 'feature')
    git('commit', '--quiet', '-m', 'squash')
    git('update-ref', 'refs/remotes/origin/main', 'HEAD')
    await expect(prove(reviewHead, git('rev-parse', 'HEAD'))).resolves.toBe(false)
  })

  it('does not probe an SSH repository path on this host', async () => {
    const { reviewHead, rebasedHead } = rebasedReview()
    await expect(prove(reviewHead, rebasedHead, 'ssh-connection')).resolves.toBe(false)
  })
})
