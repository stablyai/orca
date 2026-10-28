import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { runProcess } from '@orca/process-host'

const readWorkflow = (name) => parse(readFileSync(`.github/workflows/${name}.yml`, 'utf8'))
const windowsVet = readWorkflow('dev-channel-win-build').jobs['build-win'].steps.find(
  (step) => step.id === 'vetted'
)
const adhoc = readWorkflow('adhoc-mac-build')
const resolveSteps = adhoc.jobs['resolve-ref'].steps
const earlyVet = resolveSteps.find((step) => step.id === 'resolve')
const macSteps = adhoc.jobs['build-adhoc-mac-arch'].steps
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
    ['refs/heads/Release', lower],
    ['refs/tags/plain', upper],
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
  const output = join(scratch, 'output')
  writeFileSync(output, '')
  const result = await runProcess({
    program: 'bash',
    args: [script],
    env: {
      ...identity,
      REPO_URL: pathToFileURL(repository).href,
      RUNNER_TEMP: scratch,
      GITHUB_OUTPUT: output,
      REQUESTED_REF: ref,
      REQUESTED_SHA: ref,
      CHANNEL: 'hourly',
      TAG: 'v1.0.0-hourly.test',
      VERSION: '1.0.0-hourly.test'
    }
  })
  return { ...result, output: readFileSync(output, 'utf8') }
}

describe('release ref trust with case-twin names', () => {
  it('accepts both branch tips, annotated tags, and their common ancestor', async () => {
    for (const sha of [upper, lower, ancestor]) {
      const result = await vet(windowsVet, sha)
      expect(result.code, result.stderr).toBe(0)
    }
    for (const step of [earlyVet, macVet]) {
      for (const [ref, sha] of [
        ['Fix', upper],
        ['fix', lower],
        ['Release', lower],
        ['release', lower],
        ['refs/heads/Fix', upper],
        ['refs/tags/Release', upper],
        ['plain', upper],
        ['refs/tags/release', lower],
        [upper, upper],
        [upper.toUpperCase(), upper],
        [ancestor, ancestor]
      ]) {
        const result = await vet(step, ref)
        expect(result.code, result.stderr).toBe(0)
        expect(result.output).toBe(`sha=${sha}\n`)
      }
    }
  })

  it('rejects PR-only commits even when the server has their objects', async () => {
    for (const step of [windowsVet, earlyVet, macVet]) {
      const result = await vet(step, untrusted)
      expect(result.code).not.toBe(0)
      expect(result.stdout).toContain('not reachable from any branch or tag')
      expect(result.output).toBe('')
    }
    for (const step of [earlyVet, macVet]) {
      for (const ref of ['refs/pull/1/head', 'pull/1/head']) {
        const result = await vet(step, ref)
        expect(result.code).not.toBe(0)
        expect(result.stdout).toContain('Refusing to build PR ref')
        expect(result.output).toBe('')
      }
    }
  })

  it('rejects revision expressions and abbreviated SHAs before emitting an identity', async () => {
    for (const ref of ['Fix~1', 'Fix^{commit}', ancestor.slice(0, 12), 'missing', '--help']) {
      const result = await vet(earlyVet, ref)
      expect(result.code, ref).not.toBe(0)
      expect(result.output, ref).toBe('')
    }
  })

  it('validates before source checkout and gates every source-consuming adhoc job', () => {
    expect(resolveSteps).toHaveLength(1)
    expect(resolveSteps[0].id).toBe('resolve')
    expect(earlyVet.env.REQUESTED_REF).toBe('${{ inputs.ref || github.ref_name }}')
    expect(adhoc.jobs['resolve-ref'].outputs.sha).toBe('${{ steps.resolve.outputs.sha }}')
    expect(earlyVet.run).toBe(macVet.run)
    for (const job of Object.values(adhoc.jobs)) {
      const consumesSource =
        job.with?.ref ||
        job.steps?.some(
          (step) =>
            step.uses?.startsWith('actions/checkout@') &&
            step.with?.ref !== '${{ github.workflow_sha }}'
        )
      if (!consumesSource) {
        continue
      }
      expect([job.needs].flat()).toContain('resolve-ref')
      expect(job.if || '').not.toContain('always()')
    }
  })

  it('checks out the vetted SHA shallowly without mirroring case-twin refs again', async () => {
    expect(macCheckout.with.ref).toBe('${{ steps.vetted.outputs.sha }}')
    expect(macCheckout.with['persist-credentials']).toBe(false)
    const checkout = join(directory, 'checkout')
    const env = { ...identity, ...macCheckout.env }
    await git(['init', checkout], env)
    await git(
      [
        '-C',
        checkout,
        'fetch',
        '--no-tags',
        `--depth=${macCheckout.with['fetch-depth']}`,
        repository,
        upper
      ],
      env
    )
    await git(['-C', checkout, 'checkout', '--detach', upper], env)
    expect(await git(['-C', checkout, 'rev-parse', 'HEAD'], env)).toBe(upper)
    expect(await git(['-C', checkout, 'rev-list', '--count', 'HEAD'], env)).toBe('1')
    expect(await git(['-C', checkout, 'for-each-ref', '--format=%(refname)'], env)).toBe('')
  })
})
