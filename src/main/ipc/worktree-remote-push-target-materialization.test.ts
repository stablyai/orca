import {
  runner,
  url,
  repo,
  fork,
  a,
  b,
  interception,
  target,
  git,
  deferred,
  runtimeCommands,
  exec,
  env
} from './worktree-push-target-materialization.test-fixture'
import { resolveCheckedOutBranchName } from './worktree-push-target-setup'
import { readGitRemotePolicy } from '../../shared/git-worktree-admin'

import { readFile } from 'node:fs/promises'

import { expect, it, vi } from 'vitest'

import { hostWorktreeTarget } from '../../shared/worktree/host-qualified-identity'
import {
  configureCreatedWorktreePushTarget,
  prepareWorktreePushTarget,
  materializeWorktreePushTargetRemote
} from './worktree-remote'

import { gitFetch, gitPull, gitPush, gitFastForward } from '../git/remote'
import { getPublishTargetStatus } from '../../shared/git-publish-target-status'

import { getRemoteFileTarget } from '../git/repo-remote-file-target'

import { resolveConfiguredGitPushTarget } from '../../shared/git-push-target-resolution'

import { triggerTerminalSpawnPushTargetMaterialization } from '../runtime/runtime-terminal-spawn-push-target-materialization'
import { resolveEffectiveGitUpstream } from '../../shared/git-effective-upstream'
import { probeBranchUpstream } from '../git/branch-rename'
import { getConfiguredBranchRemoteUpstream } from '../../shared/git-configured-branch-target'
import { storeWorktreeMeta } from '../runtime/runtime-store-partial-fixture'

import '../runtime/rpc/unused-default-rpc-methods.test-fixture'

import type { WorktreeMeta } from '../../shared/worktree/meta-types'

import type { HostWorktreeTarget } from '../../shared/worktree/host-qualified-identity'
it('settles safe allocation and distinct joiner branches without annexing occupied state', async () => {
  const old = (await git(['rev-parse', 'HEAD'])).trim()
  const parent = (await git(['symbolic-ref', '--short', 'HEAD'])).trim()
  await git(['tag', 'local-a'], a)
  await git(['tag', 'local-b'], b)
  for (const [path, branch] of [
    [a, 'local-a'],
    [b, 'local-b']
  ]) {
    expect(await resolveCheckedOutBranchName((args, cwd) => runner(args, { cwd }), path)).toBe(
      branch
    )
  }
  for (const [key, value] of [
    ['remote', 'pr-contributor'],
    ['merge', 'refs/heads/main'],
    ['pushRemote', 'pr-contributor'],
    ['base', 'refs/remotes/pr-contributor/base']
  ]) {
    await git(['config', `branch.${parent}.${key}`, value])
  }
  await git(['config', 'remote.pushDefault', 'pr-contributor'])
  const parentBefore = await git([
    'config',
    '--get-regexp',
    `^(branch\\.${parent}\\.|remote\\.pushdefault$)`
  ])
  await git([
    'config',
    'remote.pr-contributor-2.fetch',
    '+refs/heads/*:refs/remotes/pr-contributor-2/*'
  ])
  await git(['remote', 'add', 'foreign', 'git@github.com:other/orca.git'])
  await git([
    'config',
    '--replace-all',
    'remote.foreign.fetch',
    '+refs/heads/secret:refs/remotes/pr-contributor-3/topic'
  ])
  await git(['update-ref', 'refs/remotes/pr-contributor-3/topic', old])
  await git(['update-ref', 'refs/remotes/pr-contributor-4/base', old])
  await git(['config', 'branch.local-a.base', 'refs/remotes/pr-contributor-4/base'])
  const before = await git(['config', '--get-regexp', '^remote\\.(foreign|pr-contributor-2)\\.'])
  const entered = deferred(),
    release = deferred(),
    joined = deferred()
  interception.intercept = async (args, cwd) => {
    if (args[0] === 'fetch' && cwd === a) {
      entered.resolve()
      await release.promise
    }
    if (args.includes('--git-common-dir') && cwd === b) {
      joined.resolve()
    }
  }
  const first = materializeWorktreePushTargetRemote(a, target())
  await entered.promise
  const second = materializeWorktreePushTargetRemote(b, target('other'))
  await joined.promise
  release.resolve()
  const selected = await Promise.all([first, second])
  expect(selected.map((item) => item.remoteName)).toEqual(['pr-contributor-5', 'pr-contributor-5'])
  expect(
    await git(['config', '--get-regexp', `^(branch\\.${parent}\\.|remote\\.pushdefault$)`])
  ).toBe(parentBefore)
  expect(await git(['rev-parse', '--symbolic-full-name', 'HEAD@{u}'], a)).toBe(
    'refs/remotes/pr-contributor-5/topic\n'
  )
  expect(await git(['rev-parse', '--symbolic-full-name', 'HEAD@{u}'], b)).toBe(
    'refs/remotes/pr-contributor-5/other\n'
  )
  expect(
    runner.mock.calls.filter(([args]) => args[0] === 'remote' && args[1] === 'add')
  ).toHaveLength(1)
  expect(await git(['config', '--get-regexp', '^remote\\.(foreign|pr-contributor-2)\\.'])).toBe(
    before
  )
  for (const ref of ['refs/remotes/pr-contributor-3/topic', 'refs/remotes/pr-contributor-4/base']) {
    expect((await git(['rev-parse', ref])).trim()).toBe(old)
  }
})

it.each(['add', 'marker', 'fetch', 'branch'])(
  'settles both failed %s callers, leaves bounded state and reuses it on retry',
  async (phase) => {
    const entered = deferred(),
      release = deferred()
    const fail = async (args: string[], cwd: string) => {
      if (cwd !== a) {
        return
      }
      const hit =
        phase === 'add'
          ? args[0] === 'remote' && args[1] === 'add'
          : phase === 'marker'
            ? args[0] === 'config' && args.includes('--local')
            : phase === 'fetch'
              ? args[0] === 'fetch'
              : args[0] === 'branch'
      if (hit) {
        entered.resolve()
        await release.promise
        throw new Error(`denied ${phase}`)
      }
    }
    if (phase === 'add') {
      interception.afterIntercept = fail
    } else {
      interception.intercept = fail
    }
    const requested = { ...target(), remoteName: 'pr-retry' }
    const owner = materializeWorktreePushTargetRemote(a, requested)
    await entered.promise
    const joiner = materializeWorktreePushTargetRemote(b, { ...requested, branchName: 'other' })
    const settled = Promise.allSettled([owner, joiner])
    await vi.waitFor(() =>
      expect(
        runner.mock.calls.some(
          ([args, options]) => args.includes('--git-common-dir') && options.cwd === b
        )
      ).toBe(true)
    )
    const index = runner.mock.calls.findIndex(
      ([args, options]) => args.includes('--git-common-dir') && options.cwd === b
    )
    await runner.mock.results[index].value
    await new Promise<void>((resolve) => setImmediate(resolve))
    release.resolve()
    expect((await settled).map((result) => result.status)).toEqual(['rejected', 'rejected'])
    expect(await git(['config', '--get-all', 'remote.pr-retry.fetch'])).toBe(
      '+refs/heads/topic*:refs/remotes/pr-retry/topic*\n'
    )
    expect(await git(['config', 'remote.pr-retry.tagOpt'])).toBe('--no-tags\n')
    expect(
      runner.mock.calls.filter(([args]) => args[0] === 'remote' && args[1] === 'remove')
    ).toEqual([])
    interception.intercept = undefined
    interception.afterIntercept = undefined
    await git(['config', 'branch.local-a.base', 'refs/remotes/pr-retry/topic'])
    const result = await materializeWorktreePushTargetRemote(a, requested)
    expect(result).toMatchObject({
      remoteName: 'pr-retry',
      remoteCreated: !['add', 'marker'].includes(phase)
    })
    expect(await git(['rev-parse', 'HEAD@{u}'], a)).toBe(await git(['rev-parse', 'topic'], fork))
    expect(
      runner.mock.calls.filter(([args]) => args[0] === 'remote' && args[1] === 'add')
    ).toHaveLength(1)
  }
)

it('re-derives savedtrue borrowing, native/app tracking, named push/pull, absence and reappearance', async () => {
  await git(['remote', 'add', 'borrowed', url])
  await git([
    'config',
    '--replace-all',
    'remote.borrowed.fetch',
    '+refs/heads/*:refs/private/*-cache'
  ])
  await git(['config', 'remote.borrowed.partialclonefilter', 'blob:none'])
  const before = await git(['config', '--get-regexp', '^remote\\.borrowed\\.'])
  const rows = new Map([
    ['local', storeWorktreeMeta()],
    ['ssh:twin', storeWorktreeMeta({ pushTarget: target('other') })]
  ])
  const persist = vi.fn((identity: HostWorktreeTarget, patch: Partial<WorktreeMeta>) => {
    const row = { ...rows.get(identity.hostId)!, ...patch }
    rows.set(identity.hostId, row)
    return row
  })
  const selected = await materializeWorktreePushTargetRemote(
    a,
    { ...target(), remoteName: 'borrowed' },
    { getAllWorktreeMeta: () => ({}), setWorktreeMeta: persist },
    'repo',
    {},
    hostWorktreeTarget({ id: `repo::${a}`, hostId: 'local' })
  )
  expect(selected.remoteCreated).toBe(false)
  expect(persist).toHaveBeenCalledWith(hostWorktreeTarget({ id: `repo::${a}`, hostId: 'local' }), {
    pushTarget: selected
  })
  expect(rows.get('local')?.pushTarget).toEqual(selected)
  expect(rows.get('ssh:twin')?.pushTarget).toEqual(target('other'))
  const unavailableStore = {
    getAllWorktreeMeta: () => ({}),
    getRepos: () => {
      throw new Error('store unavailable')
    },
    setWorktreeMeta: vi.fn()
  }
  await expect(
    materializeWorktreePushTargetRemote(
      a,
      selected,
      unavailableStore,
      'repo',
      {},
      hostWorktreeTarget({ id: `repo::${a}`, hostId: 'local' })
    )
  ).resolves.toEqual(selected)
  expect(await git(['config', '--get-regexp', '^remote\\.borrowed\\.'])).toBe(before)
  expect((await resolveEffectiveGitUpstream((args) => runner(args, { cwd: a })))?.remoteName).toBe(
    'borrowed'
  )
  expect(await getRemoteFileTarget(a, {})).toEqual({
    remoteUrl: url,
    ref: (await git(['rev-parse', 'HEAD'], a)).trim()
  })
  await git(['commit', '--allow-empty', '-qm', 'local'], a)
  expect(
    (
      await getPublishTargetStatus(
        (args) => runner(args, { cwd: a }),
        selected,
        async (name) =>
          (await readGitRemotePolicy((argv, cwd) => runner(argv, { cwd }), a, name)).fields
      )
    ).ahead
  ).toBe(1)
  await gitPush(a, false, selected)
  await gitPull(a, selected)
  expect(
    (
      await getPublishTargetStatus(
        (args) => runner(args, { cwd: a }),
        selected,
        async (name) =>
          (await readGitRemotePolicy((argv, cwd) => runner(argv, { cwd }), a, name)).fields
      )
    ).ahead
  ).toBe(0)
  const oid = (await git(['rev-parse', 'refs/heads/topic'], fork)).trim()
  await git(['update-ref', '-d', 'refs/heads/topic'], fork)
  await git(['config', 'branch.local-a.base', 'refs/private/topic-cache'], a)
  const commands = runtimeCommands()
  runner.mockClear()
  await expect(commands.fetchRuntimeGit('id:test', selected)).resolves.toEqual({ ok: true })
  expect(runner.mock.calls.filter(([args]) => args[0] === 'fetch')).toHaveLength(1)
  expect((await git(['rev-parse', 'refs/private/topic-cache'], a)).trim()).toBe(oid)
  await git(['update-ref', '-d', 'refs/private/topic-cache'], a)
  runner.mockClear()
  await commands.fetchRuntimeGit('id:test', selected)
  expect(runner.mock.calls.filter(([args]) => args[0] === 'fetch')).toHaveLength(2)
  expect(await git(['config', 'branch.local-a.remote'], a)).toBe('borrowed\n')
  await git(['update-ref', 'refs/heads/topic', oid], fork)
  await commands.fetchRuntimeGit('id:test', selected)
  expect((await git(['rev-parse', 'HEAD@{u}'], a)).trim()).toBe(oid)
  expect(await git(['config', '--get-regexp', '^remote\\.borrowed\\.'])).toBe(before)
})

it.each([
  'ordinary',
  'rewrite',
  'suppressed-rewrite',
  'split',
  'receiver',
  'mirror',
  'misleading',
  'foreign-tracking',
  'negative',
  'follow-tags',
  'follow-tags-safe',
  'user-named',
  'inference-read-failure',
  'native-inference-read-failure'
])(
  'executes generic %s endpoints with one table per native context and preserves native tracking when named',
  async (row) => {
    const nativeControl = row === 'native-inference-read-failure'
    const mode = nativeControl ? 'inference-read-failure' : row
    const literal = mode.includes('rewrite') ? 'git@literal.test:contributor/orca.git' : url
    const named = ![
      'suppressed-rewrite',
      'split',
      'mirror',
      'misleading',
      'foreign-tracking',
      'negative',
      'follow-tags',
      'inference-read-failure'
    ].includes(mode)
    await git(['clone', '--bare', '-q', repo, `${fork}-other`])
    const other = (await git(['rev-parse', 'topic'], `${fork}-other`)).trim()
    await git([
      'remote',
      'add',
      'borrowed',
      mode === 'suppressed-rewrite'
        ? literal
        : mode === 'misleading'
          ? 'git@github.com:other/orca.git'
          : url
    ])
    await git(['remote', 'add', 'orca-fork-url-probe', 'git@github.com:other/orca.git'])
    if (mode.includes('rewrite')) {
      await git(['config', `url.${url}.pushInsteadOf`, literal])
    }
    if (mode === 'suppressed-rewrite' || mode === 'split') {
      await git([
        'config',
        'remote.borrowed.pushurl',
        mode === 'split' ? 'git@github.com:other/orca.git' : literal
      ])
    }
    if (mode === 'mirror') {
      await git(['config', 'remote.borrowed.mirror', '2'])
    }
    if (mode === 'receiver' || mode === 'user-named') {
      await git(['config', 'remote.borrowed.receivepack', 'orca-test-receiver'])
    }
    const protectedRef =
      mode === 'follow-tags' ? 'refs/tag-cache/tags/annotated' : 'refs/remotes/borrowed/topic'
    if (mode === 'misleading') {
      await git(['config', 'remote.borrowed.pushurl', url])
    }
    if (
      [
        'foreign-tracking',
        'follow-tags',
        'negative',
        'misleading',
        'inference-read-failure'
      ].includes(mode)
    ) {
      await git(['update-ref', protectedRef, other])
      if (mode !== 'misleading' && mode !== 'inference-read-failure') {
        await git(['remote', 'add', 'foreign', 'git@github.com:other/orca.git'])
        await git([
          'config',
          '--replace-all',
          'remote.foreign.fetch',
          `+refs/heads/secret:${protectedRef}`
        ])
      }
    }
    if (mode === 'negative') {
      await git(['config', '--add', 'remote.borrowed.fetch', '^refs/heads/topic'])
    }
    if (mode.startsWith('follow-tags')) {
      await git([
        'config',
        '--add',
        'remote.borrowed.fetch',
        mode === 'follow-tags' ? '+refs/*:refs/tag-cache/*' : '+refs/tags/*:refs/tags/*'
      ])
      await git(['config', 'push.followTags', 'true'])
      await git(['tag', '-a', '-m', 'test', 'annotated'], a)
    }
    await git(['config', 'branch.local-a.remote', mode === 'user-named' ? 'borrowed' : literal], a)
    await git(['config', 'branch.local-a.merge', 'refs/heads/topic'], a)
    await git(['commit', '--allow-empty', '-qm', mode], a)
    if (mode === 'inference-read-failure') {
      interception.intercept = async (args) => {
        if (args.includes('--show-origin')) {
          throw new Error('optional inference denied')
        }
      }
    }
    if (nativeControl) {
      const binary = (await exec('sh', ['-c', 'command -v git'], { cwd: a, env })).stdout.trim()
      const args = ['push', '--set-upstream', literal, 'HEAD:topic']
      console.info('native literal inference-read-failure control', {
        binary,
        version: (await git(['--version'], a)).trim(),
        cwd: a,
        args,
        branchRemote: (await git(['config', 'branch.local-a.remote'], a)).trim(),
        branchMerge: (await git(['config', 'branch.local-a.merge'], a)).trim(),
        borrowedUrl: (await git(['config', 'remote.borrowed.url'], a)).trim(),
        borrowedFetch: (await git(['config', '--get-all', 'remote.borrowed.fetch'], a)).trim(),
        protectedRef,
        protectedOid: (await git(['rev-parse', protectedRef], a)).trim(),
        headOid: (await git(['rev-parse', 'HEAD'], a)).trim()
      })
      await git(args, a)
    } else {
      runner.mockClear()
      expect(
        (await resolveConfiguredGitPushTarget((args) => runner(args, { cwd: a })))?.remote
      ).toBe(named ? 'borrowed' : literal)
      expect(runner.mock.calls.filter(([args]) => args.includes('-v'))).toHaveLength(
        ['user-named', 'inference-read-failure'].includes(mode) ? 0 : 3
      )
      expect(runner.mock.calls.some(([args]) => args.includes('get-url'))).toBe(false)
      await gitPush(a)
      if (mode === 'inference-read-failure') {
        expect(runner.mock.calls.findLast(([args]) => args[0] === 'push')?.[0]).toEqual([
          'push',
          '--set-upstream',
          literal,
          'HEAD:topic'
        ])
      }
    }
    const head = (await git(['rev-parse', 'HEAD'], a)).trim()
    expect((await git(['rev-parse', 'topic'], fork)).trim()).toBe(head)
    expect((await git(['rev-parse', 'topic'], `${fork}-other`)).trim()).toBe(other)
    if (named) {
      expect((await git(['rev-parse', 'HEAD@{u}'], a)).trim()).toBe(head)
      expect(
        (await resolveEffectiveGitUpstream((args) => runner(args, { cwd: a })))?.remoteName
      ).toBe('borrowed')
    }
    if (
      [
        'misleading',
        'foreign-tracking',
        'negative',
        'follow-tags',
        'inference-read-failure'
      ].includes(mode)
    ) {
      expect((await git(['rev-parse', protectedRef])).trim()).toBe(other)
      expect(await git(['config', 'branch.local-a.remote'], a)).toBe(`${literal}\n`)
    }
    if (mode.startsWith('follow-tags')) {
      expect(await git(['rev-parse', 'refs/tags/annotated'], fork)).toBe(
        await git(['rev-parse', 'refs/tags/annotated'], a)
      )
    }
    if (mode === 'receiver' || mode === 'user-named') {
      expect(await readFile(`${fork}-receiver`, 'utf8')).toBe('used\n')
    }
  }
)

it('leaves split push policy unchanged and mints the requested explicit fork transport', async () => {
  await git(['remote', 'add', 'borrowed', url])
  await git(['config', 'remote.borrowed.pushurl', 'git@github.com:other/orca.git'])
  const before = await git(['config', '--get-regexp', '^remote\\.borrowed\\.'])
  const selected = await materializeWorktreePushTargetRemote(a, {
    ...target(),
    remoteName: 'borrowed'
  })
  expect(selected.remoteName).toBe('borrowed-2')
  await git(['commit', '--allow-empty', '-qm', 'explicit'], a)
  await gitPush(a, false, selected)
  expect((await git(['rev-parse', 'topic'], fork)).trim()).toBe(
    (await git(['rev-parse', 'HEAD'], a)).trim()
  )
  expect(await git(['config', '--get-regexp', '^remote\\.borrowed\\.'])).toBe(before)
})

it('checks fresh strict Fetch and all Pull effects while native Push keeps first-positive bookkeeping', async () => {
  await git(['remote', 'add', 'borrowed', url])
  await git(['config', '--add', 'remote.borrowed.fetch', '+refs/heads/*:refs/secondary/*'])
  const selected = await materializeWorktreePushTargetRemote(a, {
    ...target(),
    remoteName: 'borrowed'
  })
  const old = (await git(['rev-parse', 'HEAD'], a)).trim()
  await git(['update-ref', 'refs/secondary/topic', old])
  await git(['remote', 'add', 'foreign', 'git@github.com:other/orca.git'])
  await git([
    'config',
    '--replace-all',
    'remote.foreign.fetch',
    '+refs/heads/secret:refs/secondary/topic'
  ])
  await git(['commit', '--allow-empty', '-qm', 'push'], a)
  await gitPush(a, false, selected)
  expect((await git(['rev-parse', 'refs/secondary/topic'])).trim()).toBe(old)
  const before = await git(['config', '--list', '-z'])
  await expect(gitPull(a, selected)).rejects.toThrow()
  await expect(gitFastForward(a, selected)).rejects.toThrow()
  expect(await git(['config', '--list', '-z'])).toBe(before)
  await git([
    'config',
    '--replace-all',
    'remote.foreign.fetch',
    '+refs/heads/secret:refs/remotes/borrowed/topic'
  ])
  const foreign = await git(['rev-parse', 'refs/remotes/borrowed/topic'])
  await expect(gitFetch(a, selected)).rejects.toThrow()
  expect(await git(['rev-parse', 'refs/remotes/borrowed/topic'])).toBe(foreign)
  await git(['remote', 'remove', 'foreign'])
  const head = (await git(['rev-parse', 'HEAD'], a)).trim()
  const next = (await git(['commit-tree', `${head}^{tree}`, '-p', head, '-m', 'remote'], a)).trim()
  await git(['push', url, `${next}:refs/heads/topic`], a)
  await gitFastForward(a, selected)
  for (const ref of ['HEAD', 'refs/secondary/topic', 'refs/remotes/borrowed/topic']) {
    expect((await git(['rev-parse', ref], a)).trim()).toBe(next)
  }
})

it('rechecks strict Fetch after runtime preparation and settles savedtrue terminal failure then retry', async () => {
  const requested = { ...target(), remoteName: 'pr-terminal' }
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    interception.intercept = async (args) => {
      if (args[0] === 'fetch') {
        throw new Error('transport denied')
      }
    }
    triggerTerminalSpawnPushTargetMaterialization(a, requested, undefined, undefined)
    await vi.waitFor(() =>
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining('failed to materialize'),
        expect.any(Error)
      )
    )
    interception.intercept = undefined
    const done = deferred()
    interception.afterIntercept = async (args) => {
      if (args[0] === 'branch') {
        done.resolve()
      }
    }
    triggerTerminalSpawnPushTargetMaterialization(a, requested, undefined, undefined)
    await done.promise
    await expect(materializeWorktreePushTargetRemote(a, requested)).resolves.toMatchObject({
      remoteName: 'pr-terminal'
    })
    expect(
      runner.mock.calls.filter(([args]) => args[0] === 'remote' && args[1] === 'add')
    ).toHaveLength(1)
    let preparation = true
    interception.intercept = async (args) => {
      if (preparation && args[0] === 'config' && args.includes('--bool')) {
        preparation = false
        await git(['remote', 'add', 'foreign', 'git@github.com:other/orca.git'])
        await git([
          'config',
          '--replace-all',
          'remote.foreign.fetch',
          '+refs/heads/secret:refs/remotes/pr-terminal/topic'
        ])
      }
    }
    const before = await git(['rev-parse', 'refs/remotes/pr-terminal/topic'])
    await expect(runtimeCommands().fetchRuntimeGit('id:test', requested)).rejects.toThrow()
    expect(await git(['rev-parse', 'refs/remotes/pr-terminal/topic'])).toBe(before)
  } finally {
    warning.mockRestore()
  }
})

it('exhausts all99 unsafe namespaces without writing', async () => {
  await git(['remote', 'add', 'foreign', 'git@github.com:other/orca.git'])
  await git([
    'config',
    '--replace-all',
    'remote.foreign.fetch',
    '+refs/heads/foreign*:refs/remotes/pr-exhausted*/topic'
  ])
  runner.mockClear()
  await expect(
    materializeWorktreePushTargetRemote(a, { ...target(), remoteName: 'pr-exhausted' })
  ).rejects.toThrow('available remote name')
  expect(
    runner.mock.calls.some(
      ([args]) =>
        args[0] === 'fetch' ||
        (args[0] === 'config' && !args.includes('--list')) ||
        (args[0] === 'remote' && args[1] === 'add')
    )
  ).toBe(false)
})

it('uses annotated configured fallback through effective upstream, Pull and rename decisions', async () => {
  await git(['tag', 'local-a'], a)
  await git(['remote', 'add', 'borrowed', url])
  await git(['fetch', '--no-tags', 'borrowed'])
  await git(['config', 'branch.local-a.remote', url], a)
  await git(['config', 'branch.local-a.merge', 'refs/heads/topic'], a)
  const run = (args: string[]) => runner(args, { cwd: a })
  const fallback = await getConfiguredBranchRemoteUpstream(run, 'local-a', async (name, branch) => {
    await git(['rev-parse', '--verify', `refs/remotes/${name}/${branch}`], a)
    return true
  })
  expect(fallback).toMatchObject({
    remoteName: 'borrowed',
    branchName: 'topic',
    isConfiguredUpstream: false
  })
  expect(await resolveEffectiveGitUpstream(run)).toEqual(fallback)
  expect(await probeBranchUpstream(run)).toEqual({ outcome: 'has-upstream' })
  const oid = (await git(['rev-parse', 'HEAD'], a)).trim()
  const next = (await git(['commit-tree', `${oid}^{tree}`, '-p', oid, '-m', 'remote'], fork)).trim()
  await git(['update-ref', 'refs/heads/topic', next], fork)
  await gitPull(a)
  expect((await git(['rev-parse', 'HEAD'], a)).trim()).toBe(next)
})

it('keeps no-URL preparation child-only and strips creation compatibility', async () => {
  await git(['remote', 'add', 'same-repo', fork])
  const before = await git(['config', '--list', '-z'])
  const selected = await prepareWorktreePushTarget(repo, {
    remoteName: 'same-repo',
    branchName: 'topic',
    remoteCreated: true
  })
  expect(selected).toEqual({ remoteName: 'same-repo', branchName: 'topic' })
  expect(await git(['config', '--list', '-z'])).toBe(before)
  const child = await configureCreatedWorktreePushTarget(a, 'local-a', selected)
  expect(child).toEqual(selected)
  expect(await git(['rev-parse', '--symbolic-full-name', 'HEAD@{u}'], a)).toBe(
    'refs/remotes/same-repo/topic\n'
  )
  const after = (await git(['config', '--list', '-z']))
    .split('\0')
    .filter((row) => !row.startsWith('branch.local-a.'))
    .join('\0')
  expect(after).toBe(before)
})
