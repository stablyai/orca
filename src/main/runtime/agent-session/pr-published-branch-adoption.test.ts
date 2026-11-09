import { describe, expect, it } from 'vitest'
import type { GitPushTarget } from '../../../shared/worktree/types'
import {
  adoptPublishedPRBranch,
  type PublishedBranchWorkspace
} from './pr-published-branch-adoption'

const HEAD = 'bb7f2f357e1aaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const REMOTES = [
  'fork\tgit@github.com:me/orca.git (fetch)',
  'fork\tgit@github.com:me/orca.git (push)',
  'origin\tgit@github.com:stablyai/orca.git (fetch)',
  'origin\tgit@github.com:stablyai/orca.git (push)'
].join('\n')

async function adopt(
  options: {
    head?: string
    target?: GitPushTarget
    owner?: string
    opened?: boolean
    linkedGitLabMR?: number
    branch?: string
    publishedFrom?: string
    checkoutAfterRemote?: { head: string; branch: string }
    remotes?: string
  } = {}
) {
  const worktree: PublishedBranchWorkspace = {
    git: { branch: options.branch ?? 'refs/heads/quick-note' },
    linkedPR: null,
    linkedGitLabMR: options.linkedGitLabMR,
    linkedItems: [],
    pushTarget: options.target
  }
  let checkout = { head: options.head ?? HEAD, branch: worktree.git.branch }
  await adoptPublishedPRBranch({
    worktree,
    published: {
      branch: 'review',
      headSha: HEAD,
      checkoutBranch: options.publishedFrom ?? worktree.git.branch,
      pr: { host: 'github.com', owner: options.owner ?? 'stablyai', repo: 'orca', number: 42 },
      // git prints the push URL without its `git@`.
      ...(options.opened
        ? { headRepo: { owner: options.owner ?? 'stablyai', repo: 'orca' } }
        : { remoteUrl: `github.com:${options.owner ?? 'stablyai'}/orca.git` })
    },
    execGit: async (args) => ({
      stdout:
        args[0] === 'rev-parse'
          ? `${checkout.head}\n${checkout.branch}\n`
          : (options.remotes ?? REMOTES)
    }),
    resolveRemote: async (remoteName) => {
      checkout = options.checkoutAfterRemote ?? checkout
      return remoteName === 'fork'
        ? { owner: 'me', repo: 'orca' }
        : { owner: 'stablyai', repo: 'orca' }
    },
    resolvePushUrl: async (pushUrl) => {
      const owner = /github\.com:([^/]+)\//u.exec(pushUrl)?.[1]
      return owner ? { owner, repo: 'orca' } : null
    },
    update: async (updates) => Object.assign(worktree, updates)
  })
  return worktree
}

describe('adoptPublishedPRBranch', () => {
  it('keeps the verified fork repository with the PR number and push target', async () => {
    const worktree = await adopt({ owner: 'me' })
    expect(worktree).toMatchObject({
      pushTarget: { remoteName: 'fork', branchName: 'review' },
      linkedPR: 42,
      linkedItems: [
        { provider: 'github', type: 'pr', number: 42, url: 'https://github.com/me/orca/pull/42' }
      ]
    })
  })

  it('adopts a fork push even when its branch name matches the local branch', async () => {
    const worktree = await adopt({ owner: 'me', branch: 'refs/heads/review' })
    expect(worktree).toMatchObject({
      pushTarget: { remoteName: 'fork', branchName: 'review' },
      linkedPR: 42,
      linkedItems: [
        { provider: 'github', type: 'pr', number: 42, url: 'https://github.com/me/orca/pull/42' }
      ]
    })
  })

  it('adopts an opened fork PR through a remote that fetches upstream and pushes to the fork', async () => {
    const worktree = await adopt({
      owner: 'me',
      opened: true,
      remotes: [
        'origin\tgit@github.com:stablyai/orca.git (fetch)',
        'origin\tgit@github.com:me/orca.git (push)'
      ].join('\n')
    })
    expect(worktree).toMatchObject({
      pushTarget: { remoteName: 'origin', branchName: 'review' },
      linkedPR: 42
    })
  })

  it('leaves a checkout that has moved past the published commit alone', async () => {
    const worktree = await adopt({ head: '21a0e11287faaaaaaaaaaaaaaaaaaaaaaaaaaaaa' })
    expect(worktree).toMatchObject({ pushTarget: undefined, linkedPR: null, linkedItems: [] })
  })

  it('leaves a branch selected after publication at the same commit alone', async () => {
    const worktree = await adopt({
      branch: 'refs/heads/user-selected',
      publishedFrom: 'quick-note'
    })
    expect(worktree).toMatchObject({ pushTarget: undefined, linkedPR: null, linkedItems: [] })
  })

  it('preserves an active review from another provider', async () => {
    const worktree = await adopt({ linkedGitLabMR: 7 })
    expect(worktree).toMatchObject({
      linkedGitLabMR: 7,
      linkedPR: null,
      linkedItems: [],
      pushTarget: undefined
    })
  })

  it.each([
    { head: '21a0e11287faaaaaaaaaaaaaaaaaaaaaaaaaaaaa', branch: 'refs/heads/quick-note' },
    { head: HEAD, branch: 'refs/heads/user-selected' }
  ])(
    'preserves a checkout changed during remote resolution: $branch $head',
    async (checkoutAfterRemote) => {
      const worktree = await adopt({ opened: true, checkoutAfterRemote })
      expect(worktree).toMatchObject({ linkedPR: null, linkedItems: [], pushTarget: undefined })
    }
  )

  it('leaves an existing same-named branch on a different remote alone', async () => {
    const worktree = await adopt({ target: { remoteName: 'fork', branchName: 'review' } })
    expect(worktree).toMatchObject({
      pushTarget: { remoteName: 'fork', branchName: 'review' },
      linkedPR: null,
      linkedItems: []
    })
  })

  it('adopts an opened PR from its head repository without retained push evidence', async () => {
    const worktree = await adopt({ owner: 'me', opened: true })
    expect(worktree).toMatchObject({
      pushTarget: { remoteName: 'fork', branchName: 'review' },
      linkedPR: 42,
      linkedItems: [
        { provider: 'github', type: 'pr', number: 42, url: 'https://github.com/me/orca/pull/42' }
      ]
    })
  })

  it('links a PR when the existing target matches the published remote', async () => {
    const worktree = await adopt({ target: { remoteName: 'origin', branchName: 'review' } })
    expect(worktree).toMatchObject({
      pushTarget: { remoteName: 'origin', branchName: 'review' },
      linkedPR: 42,
      linkedItems: [
        {
          provider: 'github',
          type: 'pr',
          number: 42,
          url: 'https://github.com/stablyai/orca/pull/42'
        }
      ]
    })
  })
})
