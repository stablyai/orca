import {
  runner,
  legacyReadFailure,
  url,
  scratch,
  repo,
  fork,
  a,
  b,
  interception,
  target,
  git,
  deferred,
  oldForkFetch
} from './worktree-push-target-materialization.test-fixture'
import { readGitRemotePolicy } from '../../shared/git-worktree-admin'

import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'

import { join } from 'node:path'

import { expect, it } from 'vitest'

import { materializeWorktreePushTargetRemote } from './worktree-remote'
import { fetchForkBranch, maintainForkRemotes } from '../git/fork-remote-refspec'
import { gitFetch, gitPull, gitPush, gitFastForward } from '../git/remote'
import { getPublishTargetStatus } from '../../shared/git-publish-target-status'

import '../runtime/rpc/unused-default-rpc-methods.test-fixture'

it.each([
  'refs/heads/topic',
  'HEAD',
  'topic',
  'object',
  '',
  'empty-before',
  'empty-after',
  'no-colon-before',
  'dwim-before',
  'dwim-after',
  'tag-empty-before',
  'tag-empty-after'
])(
  'materializes %s native syntax without rewriting borrowed policy and completes native actions',
  async (form) => {
    await git(['remote', 'add', 'borrowed', url])
    const source =
      form === 'object'
        ? (await git(['rev-parse', 'HEAD'], a)).trim()
        : form.startsWith('empty-')
          ? 'refs/heads/topic:'
          : form === 'no-colon-before'
            ? 'refs/heads/topic'
            : form.startsWith('dwim-')
              ? 'refs/heads/topic:heads/borrowed-topic'
              : form.startsWith('tag-')
                ? 'refs/heads/topic'
                : form
    if (form.endsWith('before')) {
      await git(['config', '--unset-all', 'remote.borrowed.fetch'])
    }
    await git(['config', '--add', 'remote.borrowed.fetch', source])
    if (form.endsWith('before')) {
      await git([
        'config',
        '--add',
        'remote.borrowed.fetch',
        '+refs/heads/*:refs/remotes/borrowed/*'
      ])
    }
    const tagSource = form.startsWith('tag-empty-') ? 'refs/tags/annotated:' : 'refs/tags/annotated'
    if (!form.endsWith('after')) {
      await git(['config', '--add', 'remote.borrowed.fetch', tagSource])
    }
    await git(['config', '--add', 'remote.borrowed.fetch', '+refs/tags/*:refs/tag-cache/*'])
    if (form.endsWith('after')) {
      await git(['config', '--add', 'remote.borrowed.fetch', tagSource])
    }
    await git(['config', 'push.followTags', 'true'])
    await git(['tag', '-a', '-m', 'native syntax', 'annotated'], a)
    const policy = await git(['config', '--get-regexp', '^remote\\.borrowed\\.'])
    const selected = await materializeWorktreePushTargetRemote(a, {
      ...target(),
      remoteName: 'borrowed'
    })
    expect(selected.remoteName).toBe(
      form === 'empty-before' || form.startsWith('dwim-') ? 'borrowed-2' : 'borrowed'
    )
    expect(await git(['config', '--get-regexp', '^remote\\.borrowed\\.'])).toBe(policy)
    await expect(git(['config', '--get', 'remote.borrowed.orca-created'])).rejects.toThrow()
    await git(['commit', '--allow-empty', '-qm', 'native syntax'], a)
    await gitPush(a, false, selected)
    expect(await git(['rev-parse', 'HEAD@{u}'], a)).toBe(
      await git(['rev-parse', 'refs/heads/topic'], fork)
    )
    expect(await git(['rev-parse', 'refs/tags/annotated'], fork)).toBe(
      await git(['rev-parse', 'refs/tags/annotated'], a)
    )
    if (form === 'tag-empty-before') {
      await expect(git(['rev-parse', '--verify', 'refs/tag-cache/annotated'])).rejects.toThrow()
    } else if (selected.remoteName === 'borrowed') {
      expect(await git(['rev-parse', 'refs/tag-cache/annotated'])).toBe(
        await git(['rev-parse', 'refs/tags/annotated'], a)
      )
    }
    await expect(git(['rev-parse', '--verify', 'refs/heads/borrowed-topic'])).rejects.toThrow()
    await gitFetch(a, selected)
    await gitPull(a, selected)
    await gitFastForward(a, selected)
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
    expect(await git(['config', '--get-regexp', '^remote\\.borrowed\\.'])).toBe(policy)
  }
)

it.each([
  'remotes',
  'branches',
  'empty-remotes',
  'empty-branches',
  'config-suppresses',
  'vcs-suppresses',
  'url-less-combines',
  'foreign-legacy',
  'foreign-peer'
])('derives native %s names/policy before materialization and strict actions', async (mode) => {
  const store = join(
    repo,
    '.git',
    mode === 'branches' || mode === 'empty-branches' ? 'branches' : 'remotes'
  )
  await mkdir(store, { recursive: true })
  const filename = join(store, 'borrowed')
  let contents =
    mode === 'branches'
      ? `${url}#topic\n`
      : mode.startsWith('empty-') || mode === 'foreign-peer'
        ? ' \n'
        : `URL: ${url}\nPull: +refs/heads/*:refs/remotes/borrowed/*\n`
  if (mode === 'foreign-legacy') {
    contents = `URL: git@github.com:other/orca.git\nPull: +refs/heads/secret:refs/remotes/pr-contributor-2/topic\n`
  }
  await writeFile(filename, contents)
  if (mode === 'config-suppresses') {
    await git(['config', 'remote.borrowed.url', 'git@github.com:other/orca.git'])
    await git(['config', 'remote.borrowed.fetch', '+refs/heads/*:refs/remotes/borrowed/*'])
  }
  if (mode === 'vcs-suppresses') {
    await git(['config', 'remote.borrowed.vcs', 'unavailable-helper'])
  }
  if (mode === 'url-less-combines') {
    await git(['config', 'remote.borrowed.fetch', '+refs/heads/topic:refs/private/topic'])
  }
  if (mode === 'foreign-peer') {
    await git(['config', 'extensions.worktreeConfig', 'true'])
    await git(['config', '--worktree', 'remote.hidden.url', 'git@github.com:other/orca.git'], b)
    await git(
      [
        'config',
        '--worktree',
        'remote.hidden.fetch',
        '+refs/heads/secret:refs/remotes/pr-contributor-2/topic'
      ],
      b
    )
  }
  let protectedOid = ''
  if (mode.startsWith('foreign-')) {
    await git(['clone', '--bare', '-q', repo, `${fork}-other`])
    protectedOid = await git(['rev-parse', 'HEAD'])
    await git(['update-ref', 'refs/heads/secret', protectedOid.trim()], `${fork}-other`)
    await git(['update-ref', 'refs/remotes/pr-contributor-2/topic', protectedOid.trim()])
    await git(
      [
        'config',
        ...(mode === 'foreign-peer' ? ['--worktree'] : []),
        'branch.local-b.remote',
        mode === 'foreign-peer' ? 'hidden' : 'borrowed'
      ],
      b
    )
    await git(
      [
        'config',
        ...(mode === 'foreign-peer' ? ['--worktree'] : []),
        'branch.local-b.merge',
        'refs/heads/secret'
      ],
      b
    )
    await git(['remote', 'add', 'manual', url])
    await git([
      'config',
      '--replace-all',
      'remote.manual.fetch',
      '+refs/heads/topic:refs/remotes/pr-contributor-2/topic'
    ])
    expect(await git(['rev-parse', 'HEAD@{u}'], b)).toBe(protectedOid)
  }
  const requested = mode.startsWith('foreign-') ? target() : { ...target(), remoteName: 'borrowed' }
  const selected = await materializeWorktreePushTargetRemote(a, requested)
  const borrowed = ['remotes', 'url-less-combines'].includes(mode)
  expect(selected.remoteName).toBe(
    borrowed
      ? 'borrowed'
      : mode.startsWith('foreign-')
        ? 'pr-contributor-3'
        : mode === 'empty-branches'
          ? 'borrowed'
          : 'borrowed-2'
  )
  expect(await readFile(filename, 'utf8')).toBe(contents)
  expect(await git(['rev-parse', 'HEAD@{u}'], a)).toBe(await git(['rev-parse', 'topic'], fork))
  await git(['commit', '--allow-empty', '-qm', mode], a)
  await gitPush(a, false, selected)
  expect(await git(['rev-parse', 'HEAD@{u}'], a)).toBe(await git(['rev-parse', 'topic'], fork))
  if (mode.startsWith('foreign-')) {
    await expect(
      fetchForkBranch((args, cwd) => runner(args, { cwd }), a, 'manual', 'topic', '', url)
    ).rejects.toThrow()
    expect(await git(['rev-parse', 'HEAD@{u}'], b)).toBe(protectedOid)
  }
  expect(await readFile(filename, 'utf8')).toBe(contents)
})

it('refuses false upstream success when caller private policy overrides the common branch write', async () => {
  await git(['remote', 'add', 'borrowed', url])
  await git(['fetch', '--no-tags', 'borrowed'])
  await git(['config', 'extensions.worktreeConfig', 'true'])
  await git(['config', '--worktree', 'branch.local-a.remote', 'pr-contributor'], a)
  await git(['config', '--worktree', 'branch.local-a.merge', 'refs/heads/other'], a)
  const privateFile = join(
    (await git(['rev-parse', '--absolute-git-dir'], a)).trim(),
    'config.worktree'
  )
  const before = await readFile(privateFile, 'utf8')
  await expect(
    materializeWorktreePushTargetRemote(a, { ...target(), remoteName: 'borrowed' })
  ).rejects.toThrow('Effective Git upstream differs')
  expect(await readFile(privateFile, 'utf8')).toBe(before)
  await expect(git(['config', '--get', 'remote.borrowed.orca-created'])).rejects.toThrow()
  await writeFile(privateFile, '')
  expect(
    (await materializeWorktreePushTargetRemote(a, { ...target(), remoteName: 'borrowed' }))
      .remoteName
  ).toBe('borrowed')
  expect(await git(['rev-parse', 'HEAD@{u}'], a)).toBe(await git(['rev-parse', 'topic'], fork))
})

it.each(['collision', 'permission', 'partial-add'])(
  'settles native add %s without rollback or arbitrary automatic alias churn',
  async (mode) => {
    let refused = false
    interception.intercept = async (args, cwd) => {
      if (args[0] !== 'remote' || args[1] !== 'add' || refused) {
        return
      }
      refused = true
      const name = args.at(-2)!
      if (mode === 'collision') {
        await git(['remote', 'add', name, 'git@github.com:other/orca.git'], cwd)
        throw Object.assign(new Error('native collision'), {
          code: 3,
          stderr: `error: remote ${name} already exists.\n`
        })
      }
      if (mode === 'partial-add') {
        await git(['config', `remote.${name}.url`, url], cwd)
      }
      throw Object.assign(new Error('native configuration lock denied'), {
        code: 128,
        stderr: 'fatal: could not lock config file\n'
      })
    }
    if (mode === 'collision') {
      expect((await materializeWorktreePushTargetRemote(a, target())).remoteName).toBe(
        'pr-contributor-3'
      )
      expect(await git(['config', 'remote.pr-contributor-2.url'])).toBe(
        'git@github.com:other/orca.git\n'
      )
    } else {
      await expect(materializeWorktreePushTargetRemote(a, target())).rejects.toThrow('lock denied')
      expect(
        runner.mock.calls.filter(([args]) => args[0] === 'remote' && args[1] === 'add')
      ).toHaveLength(1)
      interception.intercept = undefined
      expect((await materializeWorktreePushTargetRemote(a, target())).remoteName).toBe(
        'pr-contributor-2'
      )
      if (mode === 'partial-add') {
        await expect(git(['config', 'remote.pr-contributor-2.orca-created'])).rejects.toThrow()
      }
    }
    expect(runner.mock.calls.some(([args]) => args[0] === 'remote' && args[1] === 'remove')).toBe(
      false
    )
    expect(await git(['rev-parse', 'HEAD@{u}'], a)).toBe(await git(['rev-parse', 'topic'], fork))
  }
)

// Base64c7d954 remote.ts + stale-refspec owner, retained only as the moved-action oracle.
it.each([
  'covered',
  'missing-requested',
  'stale-sibling',
  'transport',
  'authentication',
  'invalid-policy',
  'custom-destination',
  'no-url',
  'no-target'
])(
  'compares actual old broad repair and new exact Fetch for %s inputs/outcomes',
  async (scenario) => {
    const oldOid = (await git(['rev-parse', 'topic'], fork)).trim()
    const next = (
      await git(['commit-tree', `${oldOid}^{tree}`, '-p', oldOid, '-m', 'next'], fork)
    ).trim()
    await git(['update-ref', 'refs/heads/other', next], fork)
    await (scenario === 'missing-requested'
      ? git(['update-ref', '-d', 'refs/heads/topic'], fork)
      : git(['update-ref', 'refs/heads/topic', next], fork))
    const results: { failed: boolean; policy: string; topic: string; sibling: string }[] = []
    for (const version of ['old', 'new']) {
      const path = join(scratch, `moved-${version}`)
      await mkdir(path)
      await git(['init', '-q', path])
      // Local object import is fixture setup, independent of the operation under comparison.
      await git(['fetch', '--no-tags', fork, `${oldOid}:refs/heads/local`], path)
      await git(['symbolic-ref', 'HEAD', 'refs/heads/local'], path)
      await git(['remote', 'add', 'borrowed', url], path)
      const destination =
        scenario === 'custom-destination' ? 'refs/private/topic' : 'refs/remotes/borrowed/topic'
      if (scenario === 'custom-destination' || scenario === 'missing-requested') {
        await git(
          ['config', '--replace-all', 'remote.borrowed.fetch', `+refs/heads/topic:${destination}`],
          path
        )
      }
      if (scenario === 'stale-sibling') {
        await git(
          [
            'config',
            '--add',
            'remote.borrowed.fetch',
            '+refs/heads/deleted:refs/remotes/borrowed/deleted'
          ],
          path
        )
      }
      if (scenario === 'invalid-policy') {
        await git(['config', '--add', 'remote.borrowed.fetch', 'refs/heads/*'], path)
      }
      await git(['config', 'branch.local.remote', 'borrowed'], path)
      await git(['config', 'branch.local.merge', 'refs/heads/topic'], path)
      await git(['update-ref', destination, oldOid], path)
      await git(['update-ref', 'refs/remotes/borrowed/other', oldOid], path)
      interception.intercept = async (args, cwd) => {
        if (
          cwd === path &&
          args[0] === 'fetch' &&
          ['transport', 'authentication'].includes(scenario)
        ) {
          throw Object.assign(new Error(scenario), {
            stderr:
              scenario === 'transport'
                ? 'fatal: unable to access remote: network unreachable\n'
                : 'fatal: Authentication failed\n'
          })
        }
      }
      let failed = false
      try {
        await (version === 'old'
          ? oldForkFetch(path, scenario === 'no-target' ? undefined : 'borrowed')
          : gitFetch(
              path,
              scenario === 'no-target'
                ? undefined
                : {
                    remoteName: 'borrowed',
                    branchName: 'topic',
                    ...(scenario === 'no-url' ? {} : { remoteUrl: url })
                  }
            ))
      } catch {
        failed = true
      }
      interception.intercept = undefined
      results.push({
        failed,
        policy: await git(['config', '--get-all', 'remote.borrowed.fetch'], path).catch(() => ''),
        topic: await git(['rev-parse', destination], path).catch(() => ''),
        sibling: await git(['rev-parse', 'refs/remotes/borrowed/other'], path)
      })
    }
    for (const result of results) {
      expect(result.failed).toBe(
        ['transport', 'authentication', 'invalid-policy'].includes(scenario)
      )
    }
    if (scenario === 'missing-requested') {
      // Intended exact isolation retains the stale D and mapping; old repair deletes the last map.
      expect(results[0].policy).toBe('')
      expect(results[1].policy).toContain('refs/heads/topic:')
      expect(results[1].topic.trim()).toBe(oldOid)
    } else if (scenario === 'stale-sibling') {
      expect(results[0].policy).not.toContain('heads/deleted:')
      expect(results[1].policy).toContain('heads/deleted:')
    } else {
      expect(results[1].policy).toBe(results[0].policy)
    }
    if (
      !['transport', 'authentication', 'invalid-policy', 'missing-requested'].includes(scenario)
    ) {
      for (const result of results) {
        expect(result.topic.trim()).toBe(next)
      }
      const broad = ['no-url', 'no-target'].includes(scenario)
      expect(results[1].sibling.trim()).toBe(broad ? next : oldOid)
      if (scenario !== 'custom-destination') {
        expect(results[0].sibling.trim()).toBe(next)
      }
    }
  }
)

it.each(['directory', 'link-directory', 'dangling', 'empty-remotes', 'empty-branches'])(
  'permits usable manual policy beside native %s entries',
  async (kind, context) => {
    const remotes = join(repo, '.git', 'remotes'),
      branches = join(repo, '.git', 'branches')
    await mkdir(remotes)
    await mkdir(branches)
    const ignored = join(kind === 'empty-branches' ? branches : remotes, 'unused')
    if (kind === 'directory') {
      await mkdir(ignored)
    } else if (kind === 'link-directory' || kind === 'dangling') {
      if (process.platform === 'win32') {
        return context.skip()
      }
      await symlink(kind === 'link-directory' ? branches : join(scratch, 'missing'), ignored)
    } else {
      await writeFile(ignored, kind === 'empty-branches' ? ' \n' : '')
    }
    const file = join(remotes, 'manual'),
      contents = `URL: ${url}\nPull: +refs/heads/topic:refs/review/manual/topic\n`
    await writeFile(file, contents)
    const selected = await materializeWorktreePushTargetRemote(a, {
      ...target(),
      remoteName: 'manual'
    })
    expect(selected.remoteName).toBe('manual')
    await gitFetch(a, selected)
    await git(['commit', '--allow-empty', '-qm', 'push'], a)
    await gitPush(a, false, selected)
    expect(await git(['rev-parse', 'HEAD@{u}'], a)).toBe(
      await git(['rev-parse', 'refs/heads/topic'], fork)
    )
    expect(await readFile(file, 'utf8')).toBe(contents)
    const occupied = await git(['remote', 'get-url', 'unused'], a).then(
      () => true,
      () => false
    )
    expect(occupied).toBe(kind === 'empty-remotes')
  }
)

it.each(['maintenance', 'fetch', 'push', 'generic'])(
  'excludes real %s across awaited preparation until native caller configuration is installed',
  async (contender) => {
    await git(['remote', 'add', 'pr-managed', url])
    await git(['config', 'remote.pr-managed.orca-created', 'true'])
    const entered = deferred(),
      release = deferred(),
      contenderLocked = deferred()
    let maintenanceReads = 0
    interception.intercept = async (args, cwd) => {
      if (args[0] === 'fetch' && cwd === a) {
        entered.resolve()
        await release.promise
      }
    }
    const selected = materializeWorktreePushTargetRemote(a, {
      ...target(),
      remoteName: 'pr-managed'
    })
    await entered.promise
    const start = runner.mock.calls.length
    interception.afterIntercept = async (args) => {
      if (args.includes('--git-common-dir')) {
        contenderLocked.resolve()
      }
    }
    const competing =
      contender === 'maintenance'
        ? maintainForkRemotes((args, cwd) => runner(args, { cwd }), repo, {
            mode: 'remove',
            read: () => {
              maintenanceReads += 1
              return { metadata: [] }
            }
          })
        : contender === 'fetch'
          ? fetchForkBranch((args, cwd) => runner(args, { cwd }), a, 'pr-managed', 'topic', '', url)
          : gitPush(
              a,
              false,
              contender === 'push' ? { ...target(), remoteName: 'pr-managed' } : undefined
            )
    await contenderLocked.promise
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(maintenanceReads).toBe(0)
    expect(
      runner.mock.calls
        .slice(start)
        .some(([args]) => ['fetch', 'push', 'config', 'for-each-ref'].includes(args[0]))
    ).toBe(false)
    release.resolve()
    const actual = await selected
    const result = await competing
    if (contender === 'maintenance') {
      expect(result).toEqual([])
      expect(maintenanceReads).toBeGreaterThan(0)
    }
    expect(actual.remoteName).toBe('pr-managed')
    expect(await git(['rev-parse', '--symbolic-full-name', 'HEAD@{u}'], a)).toBe(
      'refs/remotes/pr-managed/topic\n'
    )
    expect(await git(['remote', 'get-url', 'pr-managed'])).toBe(`${url}\n`)
  }
)

it('keeps successful native lookup distinct from undecodable owning-provider current policy', async () => {
  const directory = join(repo, '.git', 'remotes')
  await mkdir(directory)
  const file = join(directory, 'manual'),
    contents = `URL: ${url}\nPull: +refs/heads/topic:refs/review/manual/topic\n`
  await writeFile(file, contents)
  expect(await git(['remote', 'get-url', 'manual'], a)).toBe(`${url}\n`)
  legacyReadFailure.file = file
  const before = await git(['config', '--list', '-z'], a)
  await expect(
    getPublishTargetStatus(
      (args) => runner(args, { cwd: a }),
      { ...target(), remoteName: 'manual' },
      async (name) =>
        (await readGitRemotePolicy((args, cwd) => runner(args, { cwd }), a, name)).fields
    )
  ).rejects.toThrow('Cannot decode current native Git policy')
  await expect(
    materializeWorktreePushTargetRemote(a, { ...target(), remoteName: 'manual' })
  ).rejects.toThrow('Cannot decode current native Git policy')
  expect(await git(['config', '--list', '-z'], a)).toBe(before)
  expect(
    runner.mock.calls.some(
      ([args]) => args[0] === 'fetch' || (args[0] === 'config' && !args.includes('--list'))
    )
  ).toBe(false)
  legacyReadFailure.file = ''
  expect(
    (await materializeWorktreePushTargetRemote(a, { ...target(), remoteName: 'manual' })).remoteName
  ).toBe('manual')
  expect(await readFile(file, 'utf8')).toBe(contents)
})
