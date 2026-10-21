import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { expect, it } from 'vitest'
import { parse } from 'yaml'
import { compileAggregateExpression } from './pr-aggregate-gate-context.mjs'

const workflow = parse(readFileSync('.github/workflows/node-server-tests.yml', 'utf8'))
const persistence = workflow.jobs.persistence
const shouldPersist = compileAggregateExpression(persistence.if, ['needs', 'github'])

function context({ qualification, producer = 'success', event = 'pull_request', draft = false }) {
  return {
    github: { event_name: event, event: { pull_request: { draft } } },
    needs: {
      changes: { outputs: { qualification } },
      mobile_web_bundle: { result: producer }
    }
  }
}

it.each([
  { qualification: 'true', producer: 'success', expected: true },
  { qualification: '', producer: 'success', expected: true },
  { qualification: 'true', producer: 'failure', expected: true },
  { qualification: 'true', producer: 'cancelled', expected: true },
  { qualification: 'true', producer: 'skipped', expected: true },
  { qualification: '', producer: 'skipped', expected: true },
  { qualification: 'false', producer: 'skipped', expected: true },
  { qualification: 'false', producer: 'skipped', draft: true, expected: false },
  { producer: 'success', event: 'workflow_dispatch', expected: true },
  { producer: 'success', event: 'schedule', expected: true }
])('starts native setup independently while retaining test-only behavior: %j', (scenario) => {
  const ctx = context(scenario)
  expect(persistence.needs).toBe('changes')
  expect(shouldPersist(ctx).coerceString()).toBe(String(scenario.expected))
  expect(shouldPersist(ctx, true).coerceString()).toBe('false')
})

it('uses the shared page for qualification and builds locally only when its producer is skipped', () => {
  const download = persistence.steps.find((step) => step.with?.name === 'orcad-mobile-web-bundle')
  const build = persistence.steps.find((step) => step.uses?.includes('build-mobile-web-bundle'))
  const serverBuild = persistence.steps.find((step) => step.run === 'pnpm build:orcad')
  expect(download.uses).toBe('actions/download-artifact@v8')
  expect(download.with.path).toBe('out/mobile-web')
  expect(persistence.steps.indexOf(download)).toBeLessThan(persistence.steps.indexOf(serverBuild))
  expect(persistence.steps.indexOf(build)).toBeLessThan(persistence.steps.indexOf(serverBuild))
  for (const qualification of ['true', '', undefined, 'false']) {
    const ctx = context({ qualification })
    expect(compileAggregateExpression(download.if)(ctx).coerceString()).toBe(
      String(qualification !== 'false')
    )
    expect(compileAggregateExpression(build.if)(ctx).coerceString()).toBe(
      String(qualification === 'false')
    )
  }
  expect(serverBuild['continue-on-error']).toBeUndefined()
})

it('starts independent Linux qualification without waiting for another platform', () => {
  for (const name of ['linux_glibc_floor', 'linux_glibc217_compat', 'linux_musl']) {
    const job = workflow.jobs[name]
    expect([job.needs].flat()).not.toContain('persistence')
    expect(job.if).not.toContain('needs.persistence')
    const evaluate = compileAggregateExpression(job.if, ['needs', 'github', 'inputs'])
    const ctx = { ...context({ qualification: 'true' }), inputs: { build_template: true } }
    expect(evaluate(ctx).coerceString()).toBe('true')
    expect(evaluate(ctx, true).coerceString()).toBe('false')
    const draft = {
      ...context({ qualification: '', draft: true, producer: 'skipped' }),
      inputs: { build_template: false }
    }
    expect(evaluate(draft).coerceString()).toBe('false')
  }
})

it('requires every platform and compatibility result before publishing a desktop template', () => {
  const template = workflow.jobs.desktop_template
  const required = [
    'persistence',
    'mobile_web_bundle',
    'linux_glibc_floor',
    'linux_glibc217_compat',
    'linux_musl'
  ]
  expect(template.needs).toEqual(required)
  const evaluate = compileAggregateExpression(template.if, ['needs', 'inputs'])
  const needs = Object.fromEntries(required.map((name) => [name, { result: 'success' }]))
  const ctx = { needs, inputs: { build_template: true } }
  expect(evaluate(ctx).coerceString()).toBe('true')
  expect(evaluate(ctx, true).coerceString()).toBe('false')
  for (const name of required) {
    for (const result of ['failure', 'cancelled', 'skipped']) {
      expect(evaluate({ ...ctx, needs: { ...needs, [name]: { result } } }).coerceString()).toBe(
        'false'
      )
    }
  }
})

it('avoids template download-cache transfers while retaining native and verification caches', () => {
  const install = persistence.steps.find((step) => step.id === 'dependencies')
  expect(install.with['native-runtime']).toContain("runner.os == 'Windows' && 'node'")
  expect(install.with['cache-pnpm-verification']).toBeUndefined()
  expect(install.with['persist-native-cache']).toBeUndefined()
  const source = install.with['cache-pnpm-store'].slice(3, -2)
  for (const os of ['Linux', 'macOS', 'Windows']) {
    for (const buildTemplate of [true, false]) {
      expect(
        runInNewContext(source, { inputs: { build_template: buildTemplate }, runner: { os } })
      ).toBe(!buildTemplate && os !== 'Windows')
    }
  }
})

const mobileWait = persistence.steps.find(
  (step) => step.name === 'Wait for the qualified mobile bundle'
)
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor

function waitForMobile(snapshots) {
  let now = 0
  let index = 0
  const calls = []
  const github = {
    rest: { actions: { listJobsForWorkflowRun: 'jobs', listWorkflowRunArtifacts: 'artifacts' } },
    async paginate(endpoint, input) {
      calls.push({ endpoint, input })
      return snapshots[Math.min(index, snapshots.length - 1)][endpoint] ?? []
    }
  }
  const execute = new AsyncFunction(
    'github',
    'context',
    'Date',
    'setTimeout',
    mobileWait.with.script
  )
  return {
    calls,
    result: execute(
      github,
      { repo: { owner: 'owner', repo: 'repo' }, runId: 42 },
      { now: () => now },
      (resolve, delay) => {
        now += delay
        index++
        resolve()
      }
    )
  }
}

const mobileProducer = (conclusion, prefix = 'orcad-template / qualify / ') => ({
  name: `${prefix}mobile_web_bundle`,
  status: conclusion ? 'completed' : 'in_progress',
  conclusion
})
const mobileArtifact = { name: 'orcad-mobile-web-bundle', expired: false }

it.each(['', 'orcad-template / ', 'orcad-template / qualify / '])(
  'waits for the same-run producer to succeed before accepting its artifact (%s)',
  async (prefix) => {
    const { result, calls } = waitForMobile([
      { artifacts: [mobileArtifact] },
      { jobs: [mobileProducer(undefined, prefix)], artifacts: [mobileArtifact] },
      {
        jobs: [mobileProducer('success', prefix)],
        artifacts: [{ ...mobileArtifact, expired: true }]
      },
      { jobs: [mobileProducer('success', prefix)], artifacts: [mobileArtifact] }
    ])
    await result
    expect(calls.filter((call) => call.endpoint === 'jobs')).toHaveLength(4)
    expect(calls.filter((call) => call.endpoint === 'artifacts')).toHaveLength(2)
    expect(calls.every((call) => call.input.run_id === 42)).toBe(true)
    expect(
      calls
        .filter((call) => call.endpoint === 'jobs')
        .every((call) => call.input.filter === 'latest')
    ).toBe(true)
  }
)

it.each(['failure', 'cancelled', 'skipped', 'timed_out', 'action_required', 'startup_failure'])(
  'rejects a %s producer even when an earlier attempt left an artifact',
  async (conclusion) => {
    await expect(
      waitForMobile([{ jobs: [mobileProducer(conclusion)], artifacts: [mobileArtifact] }]).result
    ).rejects.toThrow('Mobile bundle production did not succeed')
  }
)

it('fails closed when the producer is missing or ambiguous', async () => {
  await expect(waitForMobile([{}]).result).rejects.toThrow('Timed out')
  await expect(
    waitForMobile([{ jobs: [mobileProducer('success'), mobileProducer('success', '')] }]).result
  ).rejects.toThrow('Ambiguous')
})

it('prepares every native lane before waiting and builds with the shared page afterward', () => {
  for (const name of ['persistence', 'linux_glibc_floor', 'linux_musl']) {
    const job = workflow.jobs[name]
    const wait = job.steps.findIndex((step) => step.name === mobileWait.name)
    const download = job.steps.findIndex((step) => step.with?.name === mobileArtifact.name)
    const prepare = job.steps.findIndex(
      (step) =>
        step.uses?.includes('prepare-orcad-prebuilds') ||
        step.run?.includes('pnpm build:orcad-prebuilds')
    )
    expect(job.needs).toBe('changes')
    expect(prepare).toBeGreaterThan(-1)
    expect(prepare).toBeLessThan(wait)
    expect(wait).toBeLessThan(download)
    expect(job.steps[wait].with.script).toBe(mobileWait.with.script)
    expect(job.permissions).toEqual({ contents: 'read', actions: 'read' })
  }
  const alpine = workflow.jobs.linux_musl.steps
  const prepare = alpine.find((step) => step.name === 'Prepare native Alpine artifact')
  const verify = alpine.find(
    (step) => step.name === 'Verify native Alpine artifact and persistence'
  )
  const cleanup = alpine.find((step) => step.name === 'Clean up the Alpine qualification container')
  expect(prepare.run).toContain('mkdir -p out/mobile-web')
  expect(prepare.run).toContain('--detach --name orcad-alpine')
  expect(prepare.run).toContain('docker exec -i orcad-alpine')
  expect(prepare.run).not.toContain('pnpm build:orcad\n')
  expect(verify.run).toContain('docker exec -i orcad-alpine')
  expect(verify.run).toContain('pnpm build:orcad\n')
  expect(verify.run).toContain('pnpm test:node-server --artifact')
  expect(cleanup.if).toBe('always()')
})
