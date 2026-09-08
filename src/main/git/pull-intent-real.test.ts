import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  getEffectiveGitUpstreamStatus,
  resolveEffectiveGitUpstream
} from '../../shared/git-effective-upstream'
import { gitExecFileAsync } from './command-runner/git-exec-file'

let root: string
let repo: string
let canonical: string
let contributor: string
let env: NodeJS.ProcessEnv
const run = (args: string[]) => gitExecFileAsync(args, { cwd: repo, env, timeout: 10_000 })
const git = async (...args: string[]) => (await run(args)).stdout.trim()

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-pull-intent-'))
  repo = root
  canonical = join(root, 'canonical.git')
  contributor = join(root, 'contributor.git')
  const config = join(root, 'global-config')
  await writeFile(config, '')
  env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: config }
  await git('init', '-q')
  await git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    '-c',
    'commit.gpgSign=false',
    'commit',
    '--allow-empty',
    '-qm',
    'fixture'
  )
  await git('branch', '-M', 'feature')
  for (const target of [canonical, contributor]) {
    await git('clone', '--bare', '-q', root, target)
  }
  await git('remote', 'add', 'origin', pathToFileURL(contributor).href)
  await git('config', 'branch.feature.merge', 'refs/heads/feature')
  await git('config', 'branch.feature.pushRemote', 'origin')
  await git('config', 'remote.pushDefault', 'origin')
  await git('update-ref', 'refs/remotes/origin/feature', await git('rev-parse', 'HEAD'))
  await git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/feature')
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

it.each(['path', 'unmatched-file', 'matched-file', 'rewritten-scp', 'no-remotes'])(
  'pulls the configured %s repository independently of optional tracking refs',
  async (kind) => {
    const selector =
      kind === 'path'
        ? canonical
        : kind === 'rewritten-scp'
          ? 'git@example.invalid:canonical'
          : pathToFileURL(canonical).href
    if (kind === 'matched-file') {
      await git('remote', 'set-url', 'origin', selector)
    }
    if (kind === 'rewritten-scp') {
      await git('config', `url.${pathToFileURL(canonical).href}.insteadOf`, selector)
    }
    if (kind === 'no-remotes') {
      await git('remote', 'remove', 'origin')
    }
    await git('config', 'branch.feature.remote', selector)
    await expect(run(['rev-parse', '--abbrev-ref', 'HEAD@{u}'])).rejects.toThrow(
      'not stored as a remote-tracking branch'
    )
    const upstream = await resolveEffectiveGitUpstream(run)
    expect(upstream).toMatchObject({
      operationSelector: { kind: 'literal-url', value: selector },
      branchName: 'feature'
    })
    if (!upstream || upstream.isConfiguredUpstream) {
      throw new Error('Expected explicit pull intent')
    }
    expect(upstream.upstreamName).toBe(null)
    const status = await getEffectiveGitUpstreamStatus(run)
    expect(status.upstreamIdentity?.selector).toEqual({ kind: 'literal-url' })
    expect(status.upstreamIdentity?.mergeRef).toBe('refs/heads/feature')
    expect(status.hasUpstream).toBe(false)
    const refs = async () =>
      Promise.all(
        [root, canonical, contributor].map(
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
    for (const flags of [[], ['--ff-only']]) {
      const result = await run([
        'pull',
        '--verbose',
        '--dry-run',
        ...flags,
        upstream.operationSelector!.value,
        upstream.branchName
      ])
      expect(result.stderr).toContain(canonical.replace(/\.git$/, ''))
      expect(await refs()).toEqual(before)
    }
  }
)

it('keeps named upstream metadata and custom fetch refspecs', async () => {
  await git('config', 'branch.feature.remote', 'origin')
  await git('config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/custom/*')
  await git('update-ref', 'refs/remotes/custom/feature', await git('rev-parse', 'HEAD'))
  expect(await resolveEffectiveGitUpstream(run)).toMatchObject({
    isConfiguredUpstream: true,
    upstreamName: 'custom/feature'
  })
})

it('retains named pull intent when the configured refspec stores no tracking branch', async () => {
  await git('config', 'branch.feature.remote', 'origin')
  await git('config', '--unset-all', 'remote.origin.fetch')
  await git('update-ref', '-d', 'refs/remotes/origin/feature')
  expect(await resolveEffectiveGitUpstream(run)).toMatchObject({
    operationSelector: { kind: 'named-remote', value: 'origin' },
    upstreamName: null
  })
})

it('retains local branch upstreams', async () => {
  await git('branch', 'base')
  await git('config', 'branch.feature.remote', '.')
  await git('config', 'branch.feature.merge', 'refs/heads/base')
  expect(await resolveEffectiveGitUpstream(run)).toMatchObject({
    isConfiguredUpstream: true,
    upstreamName: 'base',
    remoteName: null
  })
})

it('propagates malformed config instead of falling through to origin', async () => {
  await writeFile(join(root, '.git', 'config'), '[broken\n')
  await expect(resolveEffectiveGitUpstream(run)).rejects.toThrow('bad config')
})

it('does not inherit metadata from a descendant of an unborn branch name', async () => {
  await git('branch', 'unborn/child')
  await git('config', 'branch.unborn/child.remote', 'origin')
  await git('config', 'branch.unborn/child.merge', 'refs/heads/feature')
  await git('symbolic-ref', 'HEAD', 'refs/heads/unborn')
  expect(await resolveEffectiveGitUpstream(run)).toBeNull()
})
