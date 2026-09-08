import {
  resolveGitStatusUpstreamRef,
  resolveGitStatusUpstreamRefBinding
} from './status-upstream-ref'
import { hasUsableHostedReviewPushTarget } from '../../shared/hosted-review-push-target-admission'
import { readOrProbeEffectiveUpstreamStatus } from './source-control/effective-upstream-status-probe'
import { resolvedUpstreamNameCache } from './source-control/resolved-upstream-name-cache'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  getEffectiveGitUpstreamStatus,
  resolveEffectiveGitUpstream
} from '../../shared/git-effective-upstream'
import { resolveConfiguredGitPushTarget } from '../../shared/git-push-target-resolution'
import { gitExecFileAsync } from './command-runner/git-exec-file'

let root: string
let target: string
let env: NodeJS.ProcessEnv
const run = (args: string[]) => gitExecFileAsync(args, { cwd: root, env, timeout: 10_000 })
const git = async (...args: string[]) => (await run(args)).stdout.trim()

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-upstream-identity-'))
  target = join(root, 'target.git')
  const config = join(root, 'global-config')
  await writeFile(config, '')
  env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: config }
  await git('init', '-q')
  await git('config', 'user.name', 'Fixture')
  await git('config', 'user.email', 'fixture@example.invalid')
  await git('config', 'commit.gpgSign', 'false')
  await git('commit', '--allow-empty', '-qm', 'base')
  await git('branch', '-M', 'feature')
  await git('branch', 'main')
  await git('branch', 'heads/feature')
  await git('commit', '--allow-empty', '-qm', 'published update')
  await git('clone', '--bare', '-q', root, target)
  await git('update-ref', 'refs/heads/feature', await git('rev-parse', 'refs/heads/main'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

it.each([
  ['origin', 'refs/remotes/origin/*', 'main', 'feature'],
  ['remotes', 'refs/remotes/remotes/*', 'feature', 'feature'],
  ['origin/team', 'refs/remotes/origin/team/*', 'feature', 'feature'],
  ['origin', 'refs/custom/published/*', 'feature', 'feature'],
  ['remotes', 'refs/heads/tracking/*', 'feature', 'feature']
])(
  'keeps %s with %s invariant under current/upstream tag collisions',
  async (remote, mapping, merge, expectedBranch) => {
    await git('remote', 'add', remote, target)
    await git('config', `remote.${remote}.fetch`, `+refs/heads/*:${mapping}`)
    await git('fetch', '-q', remote)
    await git('--git-dir', target, 'tag', 'feature', 'refs/heads/main')
    await git('config', 'branch.feature.remote', remote)
    await git('config', 'branch.feature.merge', `refs/heads/${merge}`)
    const upstreamBefore = await resolveEffectiveGitUpstream(run)
    const statusBefore = await getEffectiveGitUpstreamStatus(run)
    expect(upstreamBefore).toMatchObject({ remoteName: remote, branchName: expectedBranch })
    expect(statusBefore).toMatchObject({ hasUpstream: true, ahead: 0, behind: 1 })
    expect(await readOrProbeEffectiveUpstreamStatus(root, root, 'feature')).toEqual(statusBefore)
    expect(resolvedUpstreamNameCache.get(root)?.upstreamIdentity.trackingRef).toBe(
      upstreamBefore!.upstreamRef
    )
    expect(statusBefore.upstreamIdentity).toEqual({
      selector: { kind: 'named-remote', value: remote },
      mergeRef: `refs/heads/${expectedBranch}`,
      trackingRef: upstreamBefore!.upstreamRef
    })
    const pushTarget = { remoteName: remote, branchName: expectedBranch }
    expect(hasUsableHostedReviewPushTarget({ pushTarget, upstreamStatus: statusBefore })).toBe(
      false
    )
    const { upstreamIdentity: _identity, ...oldPeerStatus } = statusBefore
    expect(hasUsableHostedReviewPushTarget({ pushTarget, upstreamStatus: oldPeerStatus })).toBe(
      false
    )
    expect(
      hasUsableHostedReviewPushTarget({
        pushTarget,
        upstreamStatus: {
          ...statusBefore,
          upstreamName: 'unrelated/display/label'
        }
      })
    ).toBe(false)
    const watch = (trackingRef?: string) =>
      resolveGitStatusUpstreamRef(
        (args) => run(args),
        root,
        'refs/heads/feature',
        statusBefore.upstreamName!,
        new AbortController().signal,
        trackingRef
      )
    expect(await watch()).toBe(upstreamBefore!.upstreamRef)
    const pushBefore = await resolveConfiguredGitPushTarget(run)
    const tracking = mapping.replace('*', merge)
    for (const tag of [
      'feature',
      `${remote}/${merge}`,
      `${remote}/${expectedBranch}`,
      tracking.slice('refs/'.length)
    ]) {
      await git('tag', '-f', tag, 'refs/heads/main')
    }
    expect(await watch()).toBe(upstreamBefore!.upstreamRef)
    expect(await watch(statusBefore.upstreamIdentity!.trackingRef!)).toBe(
      upstreamBefore!.upstreamRef
    )
    expect(await resolveEffectiveGitUpstream(run)).toEqual(upstreamBefore)
    expect(await getEffectiveGitUpstreamStatus(run)).toEqual(statusBefore)
    expect(await readOrProbeEffectiveUpstreamStatus(root, root, 'feature')).toEqual(statusBefore)
    expect(await resolveConfiguredGitPushTarget(run)).toEqual(pushBefore)
    const refs = () =>
      Promise.all(
        [root, target].map(
          async (cwd) =>
            (
              await gitExecFileAsync(['for-each-ref', '--format=%(refname) %(objectname)'], {
                cwd,
                env,
                timeout: 10_000
              })
            ).stdout
        )
      )
    const before = await refs()
    const pull = upstreamBefore!.isConfiguredUpstream ? [] : [remote, upstreamBefore!.mergeRef]
    for (const flags of [[], ['--ff-only']]) {
      const result = await run(['pull', '--verbose', '--dry-run', ...flags, ...pull])
      expect(result.stderr).toContain(target.replace(/\.git$/, ''))
      expect(await refs()).toEqual(before)
    }
    if (pushBefore) {
      expect(pushBefore).toEqual({ remote, refspec: 'HEAD:refs/heads/feature' })
    }
    // Selecting the real heads/feature branch must consult its own intent.
    await git('config', 'branch.heads/feature.remote', target)
    await git('config', 'branch.heads/feature.merge', 'refs/heads/heads/feature')
    await git('symbolic-ref', 'HEAD', 'refs/heads/heads/feature')
    expect(await resolveEffectiveGitUpstream(run)).toMatchObject({
      operationSelector: { kind: 'literal-url', value: target },
      branchName: 'heads/feature'
    })
  }
)

it.each(['origin', 'origin/team'])(
  'uses only configured tracking evidence through status, cache and watch for %s',
  async (remote) => {
    const { updateActiveGitStatusRefBinding, clearActiveGitStatusRefBinding } =
      await import('../ipc/worktree-git-status-ref-watch')
    const { classifyWorktreeBaseChange } =
      await import('../ipc/worktree-base-directory-event-filter')
    await git('remote', 'add', remote, target)
    await git('fetch', '-q', remote)
    await git('config', 'branch.feature.remote', remote)
    await git('config', 'branch.feature.merge', 'refs/heads/feature')
    const oid = await git('rev-parse', `refs/remotes/${remote}/feature`)
    const watch = {
      kind: 'git-common' as const,
      key: root,
      path: join(root, '.git'),
      repos: new Map([['repo', { repoId: 'repo', repoName: 'repo', nestWorkspaces: false }]]),
      gitStatusRefPaths: new Set<string>()
    }
    for (const namespace of ['refs/custom/tracking', 'refs/heads/tracking']) {
      const ref = `${namespace}/feature`
      await git('config', `remote.${remote}.fetch`, `+refs/heads/*:${namespace}/*`)
      const missing = await getEffectiveGitUpstreamStatus(run)
      expect(missing).toMatchObject({
        hasUpstream: false,
        ahead: 0,
        behind: 0,
        upstreamIdentity: { selector: { kind: 'named-remote', value: remote }, trackingRef: null }
      })
      expect(await resolveEffectiveGitUpstream(run)).toMatchObject({
        remoteName: remote,
        mergeRef: 'refs/heads/feature',
        upstreamRef: null
      })
      resolvedUpstreamNameCache.delete(root)
      expect(await readOrProbeEffectiveUpstreamStatus(root, root, 'feature')).toMatchObject({
        hasUpstream: false
      })
      await git('update-ref', ref, oid)
      const status = await getEffectiveGitUpstreamStatus(run)
      expect(status).toMatchObject({
        hasUpstream: true,
        behind: 1,
        upstreamIdentity: { trackingRef: ref }
      })
      resolvedUpstreamNameCache.delete(root)
      expect(await readOrProbeEffectiveUpstreamStatus(root, root, 'feature')).toEqual(status)
      expect(await readOrProbeEffectiveUpstreamStatus(root, root, 'feature')).toEqual(status)
      await updateActiveGitStatusRefBinding(
        {
          worktreeId: `repo::${root}`,
          worktreePath: root,
          executionHostId: 'local',
          branch: 'refs/heads/feature',
          upstreamName: status.upstreamName,
          upstreamRef: ref,
          upstreamIdentity: status.upstreamIdentity
        },
        () => [watch],
        (signal) =>
          resolveGitStatusUpstreamRefBinding(
            (args) => run(args),
            root,
            'refs/heads/feature',
            status.upstreamName!,
            signal,
            ref,
            status.upstreamIdentity
          )
      )
      expect([...watch.gitStatusRefPaths]).toEqual([join(root, '.git', ref)])
      expect(
        classifyWorktreeBaseChange(watch, { type: 'update', path: join(root, '.git', ref) })
          .gitStatusRepoIds
      ).toEqual(['repo'])
      expect(
        classifyWorktreeBaseChange(watch, {
          type: 'update',
          path: join(root, '.git', `${ref}-other`)
        }).gitStatusRepoIds
      ).toEqual([])
    }
    await git('config', 'branch.feature.remote', '.')
    await git('config', 'branch.feature.merge', 'refs/heads/main')
    expect(
      await resolveGitStatusUpstreamRef(
        (args) => run(args),
        root,
        'refs/heads/feature',
        'main',
        new AbortController().signal
      )
    ).toBeUndefined()
    clearActiveGitStatusRefBinding()
  }
)
