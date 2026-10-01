import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { parse } from 'yaml'
import { classifyPrJobs } from './pr-code-change-scope.mjs'

const workflow = parse(readFileSync('.github/workflows/pr.yml', 'utf8'))
const typecheck = workflow.jobs.typecheck
const steps = typecheck.steps
const compiler = steps.find((step) => step.run === 'pnpm run typecheck')
const plan = steps.find((step) => step.id === 'unit-plan')

it('shares planning setup while keeping the heavy checks on separate runners', () => {
  expect(workflow.jobs.unit_plan).toBeUndefined()
  expect(workflow.jobs.test_native_cache).toBeUndefined()
  expect(typecheck.needs).toEqual(['code_paths'])
  expect(workflow.jobs.static_analysis.needs).toEqual(['code_paths'])
  expect(
    steps.filter((step) => step.uses === './.github/actions/install-node-dependencies')
  ).toHaveLength(1)
  expect(steps[0].with['fetch-depth']).toBeGreaterThanOrEqual(2)
  expect(compiler.background).toBeUndefined()
  expect(plan.background).toBe(true)
  expect(plan.run).toBe('node config/scripts/ci-unit-plan.mjs')
  expect(plan.env.ORCA_UNIT_SELECTION_MODE).toContain('vars.ORCA_UNIT_SELECTION_MODE')
  expect(steps.indexOf(plan)).toBeLessThan(steps.indexOf(compiler))
  const installs = workflow.jobs.static_analysis.steps.filter(
    (step) => step.uses === './.github/actions/install-node-dependencies'
  )
  expect(installs).toHaveLength(2)
  for (const install of installs) {
    expect(install.with['native-runtime']).toBe('node')
    expect(install.with['node-version']).toBe('24')
    expect(install.with['persist-native-cache']).not.toBe('false')
  }
})

it('requires compiler success and joined planning before publishing shards and admitting tests', () => {
  const join = steps.findIndex((step) => step.wait === 'unit-plan')
  const upload = steps.findIndex((step) => step.uses === 'actions/upload-artifact@v7')
  expect(join).toBeGreaterThan(steps.indexOf(compiler))
  expect(upload).toBeGreaterThan(join)
  expect(steps[upload]['continue-on-error']).toBeUndefined()
  expect(steps[upload].with.name).toBe('unit-selection-attempt-${{ github.run_attempt }}')
  expect(typecheck.outputs.shards).toBe('${{ steps.unit-plan.outputs.shards }}')
  expect(workflow.jobs.test.with.shards).toBe('${{ needs.typecheck.outputs.shards }}')
  for (const job of ['test', 'package', 'package_windows']) {
    expect(workflow.jobs[job].needs).toEqual(['code_paths', 'static_analysis', 'typecheck'])
  }
  expect(workflow.jobs.test.if).toContain("needs.static_analysis.result == 'success'")
  expect(workflow.jobs.test.if).toContain("needs.typecheck.result == 'success'")
  expect(workflow.jobs.verify.needs).toContain('static_analysis')
  expect(workflow.jobs.verify.needs).toContain('typecheck')
})

it.each(
  [['README.md'], ['mobile/src/App.tsx'], ['cloud/package.json'], ['src/main/index.ts'], []].map(
    (changed) => ({ changed })
  )
)('keeps desktop typechecking and planning off unrelated paths: $changed', ({ changed }) => {
  const scope = classifyPrJobs(changed)
  expect(typecheck.if).toBe("needs.code_paths.outputs.typecheck == 'true'")
  expect(scope.test).toBe(scope.typecheck)
  if (scope.test) {
    expect(scope.static_analysis).toBe(true)
  }
})
