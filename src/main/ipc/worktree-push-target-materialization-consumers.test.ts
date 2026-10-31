import {
  runner,
  handle,
  url,
  repo,
  fork,
  a,
  b,
  interception,
  target,
  git
} from './worktree-push-target-materialization.test-fixture'
import { readGitRemotePolicy } from '../../shared/git-worktree-admin'

import { mkdir, readFile, writeFile } from 'node:fs/promises'

import { join } from 'node:path'

import { expect, it, vi } from 'vitest'

import { materializeWorktreePushTargetRemote } from './worktree-remote'

import { gitFetch, gitPush } from '../git/remote'
import { getPublishTargetStatus } from '../../shared/git-publish-target-status'
import { getUpstreamStatus } from '../git/upstream'
import { resolveHostedReviewPushTargetForActions } from '../../shared/hosted-review-push-target'
import { getRemoteFileTarget } from '../git/repo-remote-file-target'
import { buildHostedRemoteFileUrl } from '../git/hosted-remote-url'

import {
  partialRuntimeStore,
  storeRepo,
  storeWorktreeMeta
} from '../runtime/runtime-store-partial-fixture'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import '../runtime/rpc/unused-default-rpc-methods.test-fixture'
import { RpcDispatcher } from '../runtime/rpc/dispatcher'
import { GIT_METHODS } from '../runtime/rpc/methods/git'
import { registerGitRemoteSyncHandlers } from './filesystem/git-remote/sync-handlers'
import { createFilesystemHandlerContext } from './filesystem/filesystem-handler-context'
import { createSenderScopedRequestCancellations } from './sender-scoped-request-cancellation'
import { registerWorktreeRootsForRepo } from './registered-worktree-roots-cache'
import type { Store } from '../persistence'
import type { Repo } from '../../shared/repo-types'
import type { RepoHostTarget } from '../../shared/repo-host-identity'

import type { ResolvedWorktree } from '../runtime/runtime-worktree-path-identity'
import {
  enrichMissingRepoGitRemoteIdentities,
  flushRepoGitRemoteIdentityEnrichmentForTests
} from '../repo-git-remote-identity-enrichment'
import { getProjectProviderIdentity } from '../../shared/project-host-setup-projection'
import { splitGitRemoteKey, matchGitRemoteKeyParts } from '../../shared/git-remote-identity'
import { githubAvatarIcon } from '../../shared/repo-icon'
import { getRepoExecutionHostId } from '../../shared/execution-host'

it.each(['ipc', 'rpc'])(
  'publishes annotated borrowed %s results with host-qualified readback and strict errors',
  async (entry) => {
    await git(['remote', 'add', 'borrowed', url])
    await git([
      'config',
      '--replace-all',
      'remote.borrowed.fetch',
      '+refs/heads/*:refs/private/*-cache'
    ])
    const id = `repo::${a}`
    const local = storeWorktreeMeta({ hostId: 'local', pushTarget: target() })
    const twin = storeWorktreeMeta({ hostId: 'ssh:twin', pushTarget: target('other') })
    const rows = new Map([
      ['local', local],
      ['ssh:twin', twin]
    ])
    const repos = [
      storeRepo({ id: 'repo', path: repo }),
      storeRepo({ id: 'repo', path: repo, executionHostId: 'ssh:twin' })
    ]
    const store = partialRuntimeStore({
      getRepos: () => repos,
      getRepo: () => repos[0],
      getWorktreeMeta: () => rows.get('local'),
      getWorktreeMetaForHost: (_id, host) => rows.get(host),
      setWorktreeMeta: (identity, patch) => {
        const next = { ...rows.get(identity.hostId)!, ...patch }
        rows.set(identity.hostId, next)
        return next
      }
    })
    class Runtime extends OrcaRuntimeService {
      protected override async resolveRuntimeGitTarget() {
        const worktree: ResolvedWorktree = {
          ...storeWorktreeMeta(),
          id,
          repoId: 'repo',
          path: a,
          hostId: 'local',
          parentWorktreeId: null,
          childWorktreeIds: [],
          lineage: null,
          git: { path: a, head: '', branch: 'local-a', isBare: false, isMainWorktree: false }
        }
        return { executionHostId: 'local' as const, worktree, repo: repos[0] }
      }
    }
    let dispatch: () => Promise<unknown>
    if (entry === 'rpc') {
      const dispatcher = new RpcDispatcher({ runtime: new Runtime(store), methods: GIT_METHODS })
      dispatch = () =>
        dispatcher.dispatch({
          id: 'fork',
          authToken: 'test',
          method: 'git.fetch',
          params: { worktree: `id:${id}`, pushTarget: target() }
        })
    } else {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: registration reads the fixture-owned repo/settings subset.
      registerWorktreeRootsForRepo(store as Store, repos[0], [a, b])
      const context = createFilesystemHandlerContext(
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the Git IPC handlers use the supplied repo/meta/settings subset only.
        store as Store,
        undefined,
        createSenderScopedRequestCancellations(),
        createSenderScopedRequestCancellations()
      )
      handle.mockClear()
      registerGitRemoteSyncHandlers(context)
      const fetch = handle.mock.calls.find(([name]) => name === 'git:fetch')![1]
      dispatch = () => fetch(null, { worktreePath: a, worktreeId: id, pushTarget: target() })
    }
    const result = await dispatch()
    if (entry === 'rpc') {
      expect(result).toMatchObject({ ok: true, result: { ok: true } })
    } else {
      expect(result).toBeUndefined()
    }
    expect(rows.get('local')?.pushTarget).toMatchObject({
      remoteName: 'borrowed',
      remoteCreated: false
    })
    expect(rows.get('ssh:twin')).toEqual(twin)
    expect(await git(['rev-parse', '--symbolic-full-name', 'HEAD@{u}'], a)).toBe(
      'refs/private/topic-cache\n'
    )
    interception.intercept = async (args) => {
      if (args[0] === 'fetch') {
        throw new Error('transport denied')
      }
    }
    // Remove the cached destination so materialization reaches the transport boundary.
    await git(['update-ref', '-d', 'refs/private/topic-cache'])
    if (entry === 'rpc') {
      expect(await dispatch()).toMatchObject({ ok: false })
    } else {
      await expect(dispatch()).rejects.toThrow('transport denied')
    }
    expect(await git(['config', 'remote.borrowed.url'])).toBe(`${url}\n`)
  }
)

it('publishes annotated probe identity to the owning host and avatar/filter readers', async () => {
  await git(['remote', 'add', 'upstream', url])
  const local = storeRepo({
    id: 'same-id',
    path: repo,
    repoIcon: githubAvatarIcon({ owner: 'old', repo: 'orca' })
  })
  const unavailable = storeRepo({ id: 'same-id', path: repo, executionHostId: 'ssh:offline' })
  const repos = [local, unavailable]
  const changed = vi.fn()
  const updateRepo = vi.fn(
    (identity: RepoHostTarget, patch: Pick<Partial<Repo>, 'gitRemoteIdentity' | 'repoIcon'>) => {
      const row = repos.find(
        (candidate) =>
          candidate.id === identity.id &&
          getRepoExecutionHostId(candidate) === getRepoExecutionHostId(identity)
      )
      if (!row) {
        return null
      }
      Object.assign(row, patch)
      return row
    }
  )
  enrichMissingRepoGitRemoteIdentities(
    { getRepos: () => repos, getRepo: () => local, updateRepo },
    { onChanged: changed }
  )
  await flushRepoGitRemoteIdentityEnrichmentForTests()
  expect(changed).toHaveBeenCalledOnce()
  expect(local.gitRemoteIdentity).toEqual({
    canonicalKey: 'github.com/contributor/orca',
    remoteName: 'upstream',
    remoteUrl: url
  })
  expect(unavailable.gitRemoteIdentity).toBeUndefined()
  expect(updateRepo).toHaveBeenCalledOnce()
  expect(getProjectProviderIdentity(local)).toMatchObject({ owner: 'contributor', repo: 'orca' })
  expect(local.repoIcon).toEqual(githubAvatarIcon({ owner: 'contributor', repo: 'orca' }))
  const parts = splitGitRemoteKey(local.gitRemoteIdentity?.canonicalKey, (host) => host)!
  expect(matchGitRemoteKeyParts(parts, { host: 'github.com', tail: 'contributor/orca' })).toBe(true)
  expect(matchGitRemoteKeyParts(parts, { host: 'github.com', tail: 'other/orca' })).toBe(false)
})

it('uses requested legacy policy through status, current remaps, Push and the final published permalink', async () => {
  const directory = join(repo, '.git', 'remotes')
  await mkdir(directory)
  const file = join(directory, 'manual'),
    destination = 'refs/review/manual/topic'
  const policy = `URL: ${url}\nPull: +refs/heads/topic:${destination}\n`
  await writeFile(file, policy)
  const requested = { ...target(), remoteName: 'manual' }
  const selected = await materializeWorktreePushTargetRemote(a, requested)
  expect(selected).toMatchObject({ remoteName: 'manual', remoteCreated: false })
  const read = async (name: string) =>
    (await readGitRemotePolicy((args, cwd) => runner(args, { cwd }), a, name)).fields
  const status = (patch?: (ref: string) => Promise<boolean>) =>
    getPublishTargetStatus((args) => runner(args, { cwd: a }), requested, read, patch)
  await git(['config', 'branch.local-a.remote', 'pr-contributor'], a)
  await git(['config', 'branch.local-a.merge', 'refs/heads/other'], a)
  await git(['fetch', '--no-tags', 'pr-contributor', 'other'], a)
  expect(await git(['rev-parse', '--symbolic-full-name', 'HEAD@{u}'], a)).toBe(
    'refs/remotes/pr-contributor/other\n'
  )
  await git(['commit', '--allow-empty', '-qm', 'local'], a)
  await git(['commit', '--allow-empty', '-qm', 'remote'], repo)
  await git(['push', fork, 'HEAD:topic'], repo)
  await gitFetch(a, selected)
  const patch = vi.fn(async () => true)
  expect(await status(patch)).toMatchObject({
    hasUpstream: true,
    ahead: 1,
    behind: 1,
    behindCommitsArePatchEquivalent: true
  })
  expect(patch).toHaveBeenCalledExactlyOnceWith(destination)
  expect((await git(['rev-list', '--left-right', '--count', 'HEAD...HEAD@{u}'], a)).trim()).toBe(
    '1\t0'
  )
  const publicStart = runner.mock.calls.length
  const publicStatus = await getUpstreamStatus(a, selected)
  expect(publicStatus).toEqual({
    hasUpstream: true,
    upstreamName: 'manual/topic',
    ahead: 1,
    behind: 1,
    behindCommitsArePatchEquivalent: true
  })
  const publicCalls = runner.mock.calls.slice(publicStart).map(([args]) => args)
  expect(publicCalls).toContainEqual([
    'rev-list',
    '--left-right',
    '--count',
    `HEAD...${destination}`
  ])
  expect(publicCalls).toContainEqual([
    'log',
    '--no-show-signature',
    '--no-color',
    '--oneline',
    '--cherry-mark',
    '--right-only',
    `HEAD...${destination}`,
    '--'
  ])
  const review = (upstreamStatus: Awaited<ReturnType<typeof getUpstreamStatus>>) =>
    resolveHostedReviewPushTargetForActions({
      hasHostedReviewLink: true,
      hasResolvableHostedReviewPushTargetLink: true,
      hostedReviewState: 'open',
      isHostedReviewStateLoading: false,
      pushTarget: selected,
      branchName: 'local-a',
      upstreamStatus
    })
  expect(review(publicStatus)).toEqual({
    canUseHostedReviewPushTarget: true,
    hostedReviewStateForActions: 'open',
    upstreamStatusForActions: publicStatus
  })
  await git(['push', '--force', fork, 'HEAD:topic'], a)
  await gitFetch(a, selected)
  await materializeWorktreePushTargetRemote(a, selected)
  await git(['commit', '--allow-empty', '-qm', 'published'], a)
  await gitPush(a, false, selected)
  expect(await status()).toMatchObject({ hasUpstream: true, ahead: 0, behind: 0 })
  expect(await git(['rev-parse', '--symbolic-full-name', 'HEAD@{u}'], a)).toBe(`${destination}\n`)
  const publishedStatus = await getUpstreamStatus(a, selected)
  expect(publishedStatus).toEqual({
    hasUpstream: true,
    upstreamName: 'manual/topic',
    ahead: 0,
    behind: 0
  })
  expect(review(publishedStatus)).toEqual({
    canUseHostedReviewPushTarget: true,
    hostedReviewStateForActions: 'open',
    upstreamStatusForActions: publishedStatus
  })
  const sha = (await git(['rev-parse', 'HEAD'], a)).trim()
  const fileTarget = await getRemoteFileTarget(a, {})
  expect(fileTarget).toEqual({ remoteUrl: url, ref: sha })
  if (!fileTarget) {
    throw new Error('Missing published target')
  }
  expect(buildHostedRemoteFileUrl(fileTarget.remoteUrl, 'a b.ts', fileTarget.ref, 3)).toBe(
    `https://github.com/contributor/orca/blob/${sha}/a%20b.ts#L3`
  )
  expect(await readFile(file, 'utf8')).toBe(policy)
  for (const [rows, ref] of [
    [`Pull: refs/heads/topic\n`, undefined],
    [`Pull: refs/heads/topic:\nPull: refs/heads/topic:${destination}\n`, undefined],
    [`Pull: refs/heads/topic:${destination}\nPull: ^refs/heads/topic\n`, undefined],
    [`Pull: refs/heads/topic:refs/heads/local-a\n`, 'refs/heads/local-a'],
    [`Pull: refs/heads/topic:refs/private/remapped\n`, 'refs/private/remapped']
  ] as const) {
    if (ref === 'refs/private/remapped') {
      await git(['update-ref', ref, sha], a)
    }
    await writeFile(file, `URL: ${url}\n${rows}`)
    expect(await status()).toMatchObject({ hasUpstream: Boolean(ref), ahead: 0, behind: 0 })
    if (ref) {
      expect(runner.mock.calls.some(([args]) => args.includes(`HEAD...${ref}`))).toBe(true)
    }
  }
  await writeFile(file, `URL: ${url}\nPull: invalid ref:refs/private/bad\n`)
  await expect(status()).rejects.toThrow()
})
