import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { runProcess } from '../../src/shared/child-process/run-process'

const readWorkflow = (name) => parse(readFileSync(`.github/workflows/${name}.yml`, 'utf8'))
const windowsVet = readWorkflow('dev-channel-win-build').jobs['build-win'].steps.find(
  (step) => step.id === 'vetted'
)
const macSteps = readWorkflow('adhoc-mac-build').jobs['build-adhoc-mac'].steps
const macVet = macSteps.find((step) => step.id === 'vetted')
const macCheckout = macSteps.find((step) => step.name === 'Checkout the requested ref')
const directory = mkdtempSync(join(tmpdir(), 'workflow-ref-reachability-'))
const repository = join(directory, 'remote.git')
const identity = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Ref test',
  GIT_AUTHOR_EMAIL: 'ref-test@example.com',
  GIT_COMMITTER_NAME: 'Ref test',
  GIT_COMMITTER_EMAIL: 'ref-test@example.com'
}
let ancestor, upper, lower, untrusted

async function git(args, env = identity) {
  const result = await runProcess({ program: 'git', args, env })
  expect(result.code, result.stderr).toBe(0)
  return result.stdout.trim()
}

beforeAll(async () => {
  await git(['init', '--bare', '--ref-format=reftable', repository])
  const tree = await git(['-C', repository, 'mktree'])
  ancestor = await git(['-C', repository, 'commit-tree', tree, '-m', 'ancestor'])
  upper = await git(['-C', repository, 'commit-tree', tree, '-p', ancestor, '-m', 'upper'])
  lower = await git(['-C', repository, 'commit-tree', tree, '-p', ancestor, '-m', 'lower'])
  untrusted = await git(['-C', repository, 'commit-tree', tree, '-m', 'PR only'])
  for (const [ref, sha] of [
    ['refs/heads/Fix', upper],
    ['refs/heads/fix', lower],
    ['refs/pull/1/head', untrusted]
  ]) {
    await git(['-C', repository, 'update-ref', ref, sha])
  }
  await git(['-C', repository, 'tag', '-a', 'Release', upper, '-m', 'upper tag'])
  await git(['-C', repository, 'tag', '-a', 'release', lower, '-m', 'lower tag'])
  await git(['-C', repository, 'config', 'uploadpack.allowFilter', 'true'])
})

afterAll(() => rmSync(directory, { recursive: true, force: true }))

async function vet(step, ref) {
  const scratch = mkdtempSync(join(directory, 'attempt-'))
  const script = join(scratch, 'vet.sh')
  writeFileSync(script, step.run)
  return runProcess({
    program: 'bash',
    args: [script],
    env: {
      ...identity,
      REPO_URL: pathToFileURL(repository).href,
      RUNNER_TEMP: scratch,
      GITHUB_OUTPUT: join(scratch, 'output'),
      REQUESTED_REF: ref,
      REQUESTED_SHA: ref,
      CHANNEL: 'hourly',
      TAG: 'v1.0.0-hourly.test',
      VERSION: '1.0.0-hourly.test'
    }
  })
}

describe('release ref trust with case-twin names', () => {
  it('accepts both branch tips, annotated tags, and their common ancestor', async () => {
    for (const sha of [upper, lower, ancestor]) {
      const result = await vet(windowsVet, sha)
      expect(result.code, result.stderr).toBe(0)
    }
    for (const ref of ['Fix', 'fix', 'Release', 'release', ancestor]) {
      const result = await vet(macVet, ref)
      expect(result.code, result.stderr).toBe(0)
    }
  })

  it('rejects PR-only commits even when the server has their objects', async () => {
    for (const step of [windowsVet, macVet]) {
      const result = await vet(step, untrusted)
      expect(result.code).not.toBe(0)
      expect(result.stdout).toContain('not reachable from any branch or tag')
    }
    const result = await vet(macVet, 'refs/pull/1/head')
    expect(result.code).not.toBe(0)
    expect(result.stdout).toContain('Refusing to build PR ref')
  })

  it('preserves both case variants in the subsequent full-history checkout', async () => {
    const checkout = join(directory, 'checkout')
    const env = { ...identity, ...macCheckout.env }
    await git(['init', checkout], env)
    await git(
      [
        '-C',
        checkout,
        'fetch',
        '--no-tags',
        repository,
        '+refs/heads/*:refs/remotes/origin/*',
        '+refs/tags/*:refs/tags/*'
      ],
      env
    )
    await git(['-C', checkout, 'checkout', '--detach', upper], env)
    for (const [ref, sha] of [
      ['refs/remotes/origin/Fix', upper],
      ['refs/remotes/origin/fix', lower],
      ['refs/tags/Release', upper],
      ['refs/tags/release', lower]
    ]) {
      expect(await git(['-C', checkout, 'rev-parse', `${ref}^{commit}`], env)).toBe(sha)
    }
    expect(await git(['-C', checkout, 'rev-parse', 'HEAD'], env)).toBe(upper)
  })
})
