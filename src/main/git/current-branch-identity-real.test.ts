import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { resolveEffectiveGitUpstream } from '../../shared/git-effective-upstream'
import { resolveConfiguredGitPushTarget } from '../../shared/git-push-target-resolution'
import { readCurrentGitBranchName } from '../../shared/git-current-branch'
import { gitExecFileAsync } from './command-runner/git-exec-file'

let root: string
let env: NodeJS.ProcessEnv
const run = (args: string[]) => gitExecFileAsync(args, { cwd: root, env, timeout: 10_000 })
const git = async (...args: string[]) => (await run(args)).stdout.trim()

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-branch-identity-'))
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
  await git('branch', 'heads/feature')
  await git('tag', 'feature')
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

it('retains a valid named upstream when a tag changes the display abbreviation', async () => {
  await git('remote', 'add', 'origin', join(root, 'canonical.git'))
  await git('config', 'branch.feature.remote', 'origin')
  await git('config', 'branch.feature.merge', 'refs/heads/feature')
  await git('update-ref', 'refs/remotes/origin/feature', await git('rev-parse', 'HEAD'))
  expect(await git('symbolic-ref', '--quiet', '--short', 'HEAD')).toBe('heads/feature')
  expect(await resolveEffectiveGitUpstream(run)).toMatchObject({
    isConfiguredUpstream: true,
    upstreamName: 'origin/feature',
    branchName: 'feature'
  })
})

it('pulls and pushes the actual branch intent, with the other branch as a positive control', async () => {
  const canonical = join(root, 'canonical.git')
  const contributor = join(root, 'contributor.git')
  for (const target of [canonical, contributor]) {
    await git('clone', '--bare', '-q', root, target)
  }
  for (const [branch, target] of [
    ['feature', canonical],
    ['heads/feature', contributor]
  ]) {
    await git('config', `branch.${branch}.remote`, target)
    await git('config', `branch.${branch}.pushRemote`, target)
    await git('config', `branch.${branch}.merge`, `refs/heads/${branch}`)
  }
  const refs = () =>
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
  for (const [branch, target] of [
    ['feature', canonical],
    ['heads/feature', contributor]
  ]) {
    await git('symbolic-ref', 'HEAD', `refs/heads/${branch}`)
    expect(await readCurrentGitBranchName(run)).toBe(branch)
    const up = await resolveEffectiveGitUpstream(run)
    expect(up).toMatchObject({
      operationSelector: { value: target },
      branchName: branch
    })
    const push = await resolveConfiguredGitPushTarget(run)
    expect(push).toEqual({
      remote: target,
      refspec: `HEAD:refs/heads/${branch}`
    })
    const before = await refs()
    for (const args of [
      ['pull', '--verbose', '--dry-run'],
      ['pull', '--verbose', '--dry-run', up!.remoteName!, up!.branchName],
      ['push', '--porcelain', '--dry-run'],
      ['push', '--porcelain', '--dry-run', push!.remote, push!.refspec]
    ]) {
      const result = await run(args)
      expect(result.stdout + result.stderr).toContain(target.replace(/\.git$/, ''))
      expect(await refs()).toEqual(before)
    }
  }
})
