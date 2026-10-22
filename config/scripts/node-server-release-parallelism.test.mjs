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
  { qualification: 'true', producer: 'failure', expected: false },
  { qualification: 'true', producer: 'cancelled', expected: false },
  { qualification: 'true', producer: 'skipped', expected: false },
  { qualification: '', producer: 'skipped', expected: false },
  { qualification: 'false', producer: 'skipped', expected: true },
  { qualification: 'false', producer: 'skipped', draft: true, expected: false },
  { producer: 'success', event: 'workflow_dispatch', expected: true },
  { producer: 'success', event: 'schedule', expected: true }
])('gates qualification on the bundle while retaining test-only behavior: %j', (scenario) => {
  const ctx = context(scenario)
  expect(persistence.needs).toEqual(['changes', 'mobile_web_bundle'])
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

it('prepares template dependencies before waiting for every qualification lane', () => {
  const template = workflow.jobs.desktop_template
  expect(template.needs).toBe('changes')
  expect(template.permissions).toEqual({ contents: 'read', actions: 'read' })
  const evaluate = compileAggregateExpression(template.if, ['inputs'])
  expect(evaluate({ inputs: { build_template: true } }).coerceString()).toBe('true')
  expect(evaluate({ inputs: { build_template: false } }).coerceString()).toBe('false')
  expect(evaluate({ inputs: { build_template: true } }, true).coerceString()).toBe('false')
  const wait = template.steps.findIndex(
    (step) => step.name === 'Wait for every template qualification lane'
  )
  expect(
    template.steps.findIndex((step) => step.uses?.includes('install-node-dependencies'))
  ).toBeLessThan(wait)
  expect(
    template.steps.findIndex((step) => step.name === "Collect every lane's slot")
  ).toBeGreaterThan(wait)
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
        runInNewContext(source, {
          inputs: { build_template: buildTemplate, fast_runners: false },
          matrix: { os: '' },
          runner: { os }
        })
      ).toBe(!buildTemplate && os !== 'Windows')
    }
  }
})

it.each(['persistence', 'linux_glibc_floor', 'linux_musl'])(
  '%s waits through the dependency graph without polling the Actions API',
  (name) => {
    const job = workflow.jobs[name]
    expect(job.needs).toEqual(['changes', 'mobile_web_bundle'])
    expect(job.steps.some((step) => step.uses?.includes('github-script'))).toBe(false)
    const evaluate = compileAggregateExpression(job.if, ['needs', 'github', 'inputs'])
    for (const producer of ['success', 'failure', 'cancelled', 'skipped', 'timed_out']) {
      const ctx = {
        ...context({ qualification: 'true', producer }),
        inputs: { build_template: true }
      }
      expect(evaluate(ctx).coerceString()).toBe(String(producer === 'success'))
    }
  }
)

it('prepares every native lane and builds with the shared page', () => {
  for (const name of ['persistence', 'linux_glibc_floor', 'linux_musl']) {
    const job = workflow.jobs[name]
    const download = job.steps.findIndex((step) => step.with?.name === 'orcad-mobile-web-bundle')
    const prepare = job.steps.findIndex(
      (step) =>
        step.uses?.includes('prepare-orcad-prebuilds') ||
        step.run?.includes('pnpm build:orcad-prebuilds')
    )
    expect(job.needs).toEqual(['changes', 'mobile_web_bundle'])
    expect(prepare).toBeGreaterThan(-1)
    expect(prepare).toBeLessThan(download)
    expect(job.permissions).toEqual({ contents: 'read' })
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
