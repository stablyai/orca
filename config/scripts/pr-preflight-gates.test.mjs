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
  expect(plan.run.trim().split('\n')).toEqual([
    'if [ "$PREFLIGHT_PHASE_SELECTED" != true ] || [ "$PREFLIGHT_PRIOR_SUCCESS" != true ]; then exit 0; fi',
    'node config/scripts/ci-unit-plan.mjs'
  ])
  expect(plan.env.ORCA_UNIT_SELECTION_MODE).toContain('vars.ORCA_UNIT_SELECTION_MODE')
  expect(plan.env.ORCA_UNIT_FULL_SHARD_COUNT).toBe("${{ vars.ORCA_UNIT_FULL_SHARD_COUNT || '5' }}")
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
      needs: { code_paths: { result: 'success', outputs: { test: 'true' } }, preflight: { result } }
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

it.each([
  { name: 'both phases succeed', phases: ['true', 'true'], result: 'success', admitted: true },
  { name: 'static-only succeeds', phases: ['true', 'false'], result: 'success', admitted: true },
  { name: 'type-only succeeds', phases: ['false', 'true'], result: 'success', admitted: true },
  { name: 'static-only fails', phases: ['true', 'false'], result: 'failure', admitted: false },
  { name: 'type-only fails', phases: ['false', 'true'], result: 'failure', admitted: false },
  { name: 'both phases fail', phases: ['true', 'true'], result: 'failure', admitted: false },
  { name: 'preflight is cancelled', result: 'cancelled', admitted: false },
  { name: 'preflight is unfinished', result: undefined, admitted: false },
  { name: 'both phases unselected', phases: ['false', 'false'], result: 'skipped', admitted: true },
  { name: 'required static skips', phases: ['true', 'false'], result: 'skipped', admitted: false },
  {
    name: 'required compiler skips',
    phases: ['false', 'true'],
    result: 'skipped',
    admitted: false
  },
  { name: 'both required phases skip', result: 'skipped', admitted: false },
  {
    name: 'unselected preflight fails',
    phases: ['false', 'false'],
    result: 'failure',
    admitted: false
  },
  {
    name: 'static selection missing',
    phases: [undefined, 'false'],
    result: 'skipped',
    admitted: false
  },
  {
    name: 'compiler selection missing',
    phases: ['false', undefined],
    result: 'skipped',
    admitted: false
  },
  { name: 'selection unknown', phases: ['', 'false'], result: 'skipped', admitted: false },
  {
    name: 'docs have no route',
    phases: ['false', 'false'],
    result: 'skipped',
    route: 'false',
    admitted: false
  },
  { name: 'source has no route', result: 'success', route: 'false', admitted: false },
  { name: 'route missing', result: 'success', route: '', admitted: false },
  { name: 'path detection fails', result: 'success', pathsResult: 'failure', admitted: false },
  { name: 'path detection skips', result: 'skipped', pathsResult: 'skipped', admitted: false },
  { name: 'workflow cancelled after success', result: 'success', cancelled: true, admitted: false },
  {
    name: 'workflow cancelled with unselected phases',
    phases: ['false', 'false'],
    result: 'skipped',
    cancelled: true,
    admitted: false
  }
])('admits advisory E2E only after eligible preflight: $name', (scenario) => {
  const [static_analysis, typecheck] = scenario.phases ?? ['true', 'true']
  expect(workflow.jobs.e2e.needs).toEqual(['code_paths', 'preflight'])
  const admitted = runInNewContext(workflow.jobs.e2e.if, {
    cancelled: () => scenario.cancelled ?? false,
    needs: {
      code_paths: {
        result: scenario.pathsResult ?? 'success',
        outputs: { static_analysis, typecheck, e2e_should_run: scenario.route ?? 'true' }
      },
      preflight: { result: scenario.result }
    }
  })
  expect(admitted).toBe(scenario.admitted)
})

it.each(['true', 'false'])(
  'preserves advisory E2E on ready-for-review only with proven required-check reuse: %s',
  (reused) => {
    const scope = classifyPrJobs(['src/main/runtime/orca-runtime.ts'])
    const context = {
      steps: {
        readiness: { outputs: { reused } },
        filter: {
          outputs: Object.fromEntries(
            Object.entries(scope).map(([key, value]) => [key, String(value)])
          )
        },
        e2e_filter: { outputs: { should_run: 'true' } }
      }
    }
    const outputs = Object.fromEntries(
      ['static_analysis', 'typecheck', 'e2e_should_run'].map((name) => [
        name,
        String(runInNewContext(workflow.jobs.code_paths.outputs[name].slice(3, -2), context))
      ])
    )
    expect(outputs).toEqual({
      static_analysis: reused === 'true' ? 'false' : 'true',
      typecheck: reused === 'true' ? 'false' : 'true',
      e2e_should_run: 'true'
    })
    const needs = { code_paths: { result: 'success', outputs }, preflight: { result: 'skipped' } }
    expect(runInNewContext(preflight.if, { needs })).toBe(reused !== 'true')
    expect(runInNewContext(workflow.jobs.e2e.if, { needs, cancelled: () => false })).toBe(
      reused === 'true'
    )
    expect(workflow.jobs.verify.needs).not.toContain('e2e')
  }
)

it('pins every foreground and background step to its selected phase', () => {
  const staticPhase = "needs.code_paths.outputs.static_analysis == 'true'"
  const typePhase = "needs.code_paths.outputs.typecheck == 'true'"
  const foreground = steps.filter(
    (step) => !step.background && /outputs\.(static_analysis|typecheck)/.test(step.if ?? '')
  )
  expect(foreground.map((step) => [step.name ?? step.run ?? step.uses, step.if])).toEqual([
    ['Set up Bun for localization checks', staticPhase],
    ['Reject low-evidence patterns', staticPhase],
    ['Enforce type-aware code-quality baseline', staticPhase],
    [
      './.github/actions/install-mobile-dependencies',
      `${staticPhase} && needs.code_paths.outputs.mobile_dependencies == 'true'`
    ],
    ['Enforce React Doctor on changed lines', staticPhase],
    ['Check Zustand selector fan-out budget', staticPhase],
    ['Check reliability gate manifest', staticPhase],
    ['Enforce dead design-system classes', staticPhase],
    ['Check VM runtime rollback compatibility', staticPhase],
    ['Enforce max-lines ratchet', staticPhase],
    ['Enforce ts-nocheck ratchet', staticPhase],
    ['Enforce runtime Electron-import ratchet', staticPhase],
    ['Enforce owner-routing ratchet', staticPhase],
    ['Check Node runtime pin', staticPhase],
    ['Boot orcad and round-trip a terminal', staticPhase],
    ['Verify the generated RPC params catalog', staticPhase],
    ['Verify the generated ACP protocol schema', staticPhase],
    ['Verify bundled skill guides', staticPhase],
    ['Verify skill freshness manifest', staticPhase],
    ['Verify localization coverage', staticPhase],
    ['Guard against project-owned .d.ts in preload/shared', staticPhase],
    ['Check feature wall asset budget', staticPhase],
    ['Verify macOS entitlements', staticPhase],
    ['Cache TypeScript incremental state', typePhase],
    ['pnpm run typecheck', typePhase],
    ['actions/upload-artifact@v7', typePhase]
  ])
  expect(
    steps
      .filter((step) => step.background)
      .map((step) => [step.id, step.env.PREFLIGHT_PHASE_SELECTED])
  ).toEqual([
    ['process-host-imports', `\${{ ${staticPhase} }}`],
    ['root-lint', `\${{ ${staticPhase} }}`],
    ['native-code-quality', `\${{ ${staticPhase} }}`],
    ['changed-code-quality', `\${{ ${staticPhase} }}`],
    ['localization-extraction', `\${{ ${staticPhase} }}`],
    ['localization-catalogs', `\${{ ${staticPhase} }}`],
    ['unit-plan', `\${{ ${typePhase} }}`]
  ])
})

it.each([
  { changed: ['README.md'], static_analysis: false, typecheck: false, mobile_dependencies: false },
  {
    changed: ['mobile/src/App.tsx'],
    static_analysis: true,
    typecheck: false,
    mobile_dependencies: true
  },
  {
    changed: ['cloud/package.json'],
    static_analysis: false,
    typecheck: false,
    mobile_dependencies: false
  },
  {
    changed: ['src/main/index.ts'],
    static_analysis: true,
    typecheck: true,
    mobile_dependencies: false
  },
  {
    changed: ['mobile/src/App.tsx', 'src/main/index.ts'],
    static_analysis: true,
    typecheck: true,
    mobile_dependencies: true
  },
  { changed: [], static_analysis: true, typecheck: true, mobile_dependencies: true }
])('preserves exact phase selection for unrelated paths: $changed', ({ changed, ...expected }) => {
  const scope = classifyPrJobs(changed)
  expect({
    static_analysis: scope.static_analysis,
    typecheck: scope.typecheck,
    mobile_dependencies: scope.mobile_dependencies
  }).toEqual(expected)
  const needs = {
    code_paths: {
      outputs: Object.fromEntries(Object.entries(scope).map(([key, value]) => [key, String(value)]))
    }
  }
  expect(runInNewContext(preflight.if, { needs })).toBe(
    expected.static_analysis || expected.typecheck
  )
  expect(runInNewContext(compiler.if, { needs })).toBe(expected.typecheck)
  expect(scope.test).toBe(expected.typecheck)
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
