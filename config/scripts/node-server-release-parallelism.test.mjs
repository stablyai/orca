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
])('preserves mobile producer failure and test-only behavior: %j', (scenario) => {
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
