import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { gitExecFileAsync } from './command-runner/git-exec-file'
import { readGitRemoteTrackingRef } from '../../shared/git-remote-tracking-ref'
import { getPublishTargetStatus } from '../../shared/git-publish-target-status'

let root: string
let env: NodeJS.ProcessEnv
const run = (args: string[]) => gitExecFileAsync(args, { cwd: root, env, timeout: 10_000 })
const git = async (...args: string[]) => (await run(args)).stdout.trim()
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-refspec-abbreviation-'))
  env = {
    ...process.env,
    HOME: root,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(root, 'empty-config')
  }
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
    'base'
  )
  await git('branch', '-M', 'feature')
  await git('clone', '--bare', '-q', root, join(root, 'remote.git'))
  await git('remote', 'add', 'origin', join(root, 'remote.git'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

it.each([
  ['feature:refs/custom/exact-feature', 'refs/custom/exact-feature'],
  ['heads/feature:refs/custom/exact-feature', 'refs/custom/exact-feature'],
  ['feature:custom', 'refs/heads/custom'],
  ['feature:heads/tracked', 'refs/heads/tracked'],
  ['feature:tags/tracked', 'refs/tags/tracked'],
  ['feature:remotes/origin/tracked', 'refs/remotes/origin/tracked']
])('corroborates source and destination like real Git for %s', async (mapping, ref) => {
  await git('config', 'remote.origin.fetch', mapping)
  await git('fetch', '-q', 'origin')
  expect(await readGitRemoteTrackingRef(run, 'origin', 'feature')).toBe(ref)
  expect(
    await getPublishTargetStatus(run, { remoteName: 'origin', branchName: 'feature' })
  ).toMatchObject({ hasUpstream: true, upstreamIdentity: { trackingRef: ref } })
  const before = await git('for-each-ref', '--format=%(refname) %(objectname)')
  await git('fetch', '--dry-run', 'origin')
  expect(await git('for-each-ref', '--format=%(refname) %(objectname)')).toBe(before)
})

it('does not relabel a higher-ranked tag or a missing source as the review branch', async () => {
  await git('--git-dir', join(root, 'remote.git'), 'tag', 'feature')
  await git('config', 'remote.origin.fetch', 'feature:refs/custom/from-tag')
  await git('fetch', '-q', 'origin')
  expect(await git('rev-parse', '--verify', 'refs/custom/from-tag')).toBeTruthy()
  expect(await readGitRemoteTrackingRef(run, 'origin', 'feature')).toBeNull()
  await git('config', 'remote.origin.fetch', 'missing:refs/custom/from-tag')
  expect(await readGitRemoteTrackingRef(run, 'origin', 'missing')).toBeNull()
})
