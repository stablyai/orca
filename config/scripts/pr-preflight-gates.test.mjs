import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { expect, it } from 'vitest'
import { parse } from 'yaml'
import { classifyPrJobs } from './pr-code-change-scope.mjs'

const workflow = parse(readFileSync('.github/workflows/pr.yml', 'utf8'))
const preflight = workflow.jobs.preflight
const steps = preflight.steps
const compiler = steps.find((step) => step.run === 'pnpm run typecheck')
const plan = steps.find((step) => step.id === 'unit-plan')

it('shares one setup and runs the unchanged compiler after static checks finish', () => {
  expect(workflow.jobs.static_analysis).toBeUndefined()
  expect(workflow.jobs.typecheck).toBeUndefined()
  expect(preflight.needs).toEqual(['code_paths'])
  expect(preflight['runs-on']).toBe('ubuntu-24.04-arm')
  const installs = steps.filter(
    (step) => step.uses === './.github/actions/install-node-dependencies'
  )
  expect(installs).toHaveLength(2)
  for (const install of installs) {
    expect(install.with['native-runtime']).toBe('node')
    expect(install.with['node-version']).toBe('24')
    expect(install.with['persist-native-cache']).not.toBe('false')
  }
  expect(steps[0].with['fetch-depth']).toBeGreaterThanOrEqual(2)
  expect(compiler.background).toBeUndefined()
  expect(plan.background).toBe(true)
  expect(plan.run).toContain('node config/scripts/ci-unit-plan.mjs')
  expect(plan.env.ORCA_UNIT_SELECTION_MODE).toContain('vars.ORCA_UNIT_SELECTION_MODE')
  expect(steps.indexOf(plan)).toBeLessThan(steps.indexOf(compiler))
  expect(steps.indexOf(compiler)).toBeGreaterThan(
    steps.findIndex((step) => step.wait?.includes('localization-extraction'))
  )
})

it('requires physical preflight success before publishing shards and admitting consumers', () => {
  const join = steps.findIndex((step) => step.wait === 'unit-plan')
  const upload = steps.findIndex((step) => step.uses === 'actions/upload-artifact@v7')
  expect(join).toBeGreaterThan(steps.indexOf(compiler))
  expect(upload).toBeGreaterThan(join)
  expect(steps[upload]['continue-on-error']).toBeUndefined()
  expect(steps[upload].with.name).toBe('unit-selection-attempt-${{ github.run_attempt }}')
  expect(preflight.outputs.shards).toBe('${{ steps.unit-plan.outputs.shards }}')
  expect(workflow.jobs.test.with.shards).toBe('${{ needs.preflight.outputs.shards }}')
  for (const job of ['test', 'package', 'package_windows']) {
    expect(workflow.jobs[job].needs).toEqual(['code_paths', 'preflight'])
  }
  for (const result of ['success', 'failure', 'cancelled', 'skipped']) {
    const admitted = runInNewContext(workflow.jobs.test.if, {
      cancelled: () => false,
      needs: { code_paths: { outputs: { test: 'true' } }, preflight: { result } }
    })
    expect(admitted, result).toBe(result === 'success')
  }
  const verify = workflow.jobs.verify.steps.find(
    (step) => step.name === 'Require successful checks'
  )
  expect(verify.env.PREFLIGHT).toBe('${{ needs.preflight.result }}')
  expect(verify.env.PREFLIGHT_SHOULD_RUN).toBe(
    "${{ needs.code_paths.outputs.static_analysis == 'true' || needs.code_paths.outputs.typecheck == 'true' }}"
  )
  expect(verify.run).toContain('check_job preflight "$PREFLIGHT" "$PREFLIGHT_SHOULD_RUN"')
  expect(workflow.jobs.verify.needs).toContain('preflight')
  expect(workflow.jobs.verify.needs).not.toContain('typecheck')
})

it.each(
  [['README.md'], ['mobile/src/App.tsx'], ['cloud/package.json'], ['src/main/index.ts'], []].map(
    (changed) => ({ changed })
  )
)('preserves phase selection for unrelated paths: $changed', ({ changed }) => {
  const scope = classifyPrJobs(changed)
  const needs = {
    code_paths: {
      outputs: Object.fromEntries(Object.entries(scope).map(([key, value]) => [key, String(value)]))
    }
  }
  expect(runInNewContext(preflight.if, { needs })).toBe(scope.static_analysis || scope.typecheck)
  expect(runInNewContext(compiler.if, { needs })).toBe(scope.typecheck)
  expect(scope.test).toBe(scope.typecheck)
})

it('registers successful no-op background work when a phase is unselected or already failed', () => {
  for (const step of steps.filter((step) => step.background)) {
    expect(step.if).toBe('!cancelled()')
    expect(step.env.PREFLIGHT_PHASE_SELECTED).toContain('needs.code_paths.outputs.')
    expect(step.env.PREFLIGHT_PRIOR_SUCCESS).toBe("${{ job.status == 'success' }}")
    expect(step.run.split('\n')[0]).toBe(
      'if [ "$PREFLIGHT_PHASE_SELECTED" != true ] || [ "$PREFLIGHT_PRIOR_SUCCESS" != true ]; then exit 0; fi'
    )
  }
})
