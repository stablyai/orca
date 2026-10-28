import { readFileSync, readdirSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { expect, it } from 'vitest'
import { runProcess } from '@orca/process-host'
import { parse } from 'yaml'
import { classifyPrJobs } from './pr-code-change-scope.mjs'

const workflow = parse(readFileSync('.github/workflows/pr.yml', 'utf8'))
const preflight = workflow.jobs.preflight
const steps = preflight.steps
const compiler = steps.find((step) => step.id === 'typecheck')
const compilerJoin = steps.findIndex((step) => step.wait === 'typecheck')
const plan = steps.find((step) => step.id === 'unit-plan')

it('shares one setup and overlaps the compiler only after type-aware checks finish', () => {
  expect(workflow.jobs.static_analysis).toBeUndefined()
  expect(workflow.jobs.typecheck).toBeUndefined()
  expect(preflight.needs).toEqual(['code_paths'])
  expect(preflight['runs-on']).toBe('blacksmith-8vcpu-ubuntu-2404')
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
  expect(compiler.background).toBe(true)
  expect(compiler.run).toContain('pnpm run typecheck:ci')
  const bunSetup = steps.find((step) => step.name === 'Set up Bun for preflight checks')
  expect(bunSetup.with['bun-version-file']).toBe('config/.bun-version')
  expect(bunSetup.if).toBeUndefined()
  expect(plan.background).toBe(true)
  expect(plan.run.trim().split('\n')).toEqual([
    'if [ "$PREFLIGHT_PHASE_SELECTED" != true ] || [ "$PREFLIGHT_PRIOR_SUCCESS" != true ]; then exit 0; fi',
    'node config/scripts/ci-unit-plan.mjs'
  ])
  expect(plan.env.ORCA_UNIT_SELECTION_MODE).toContain('vars.ORCA_UNIT_SELECTION_MODE')
  expect(plan.env.ORCA_UNIT_FULL_SHARD_COUNT).toBe("${{ vars.ORCA_UNIT_FULL_SHARD_COUNT || '5' }}")
  expect(steps.indexOf(plan)).toBeLessThan(compilerJoin)
  expect(steps.indexOf(compiler)).toBeGreaterThan(
    steps.findIndex((step) => step.wait === 'changed-code-quality')
  )
  expect(steps.indexOf(compiler)).toBeLessThan(
    steps.findIndex((step) => step.id === 'localization-extraction')
  )
  expect(compilerJoin).toBeGreaterThan(
    steps.findIndex((step) => step.wait?.includes('localization-extraction'))
  )
})

it('uses the shared Bun pin for every current-toolchain workflow', () => {
  expect(readFileSync('config/.bun-version', 'utf8').trim()).toMatch(/^\d+\.\d+\.\d+$/)
  for (const file of readdirSync('.github/workflows').filter((name) => /\.ya?ml$/.test(name))) {
    const current = parse(readFileSync(`.github/workflows/${file}`, 'utf8'))
    for (const job of Object.values(current.jobs)) {
      for (const step of job.steps ?? []) {
        if (!String(step.uses).startsWith('oven-sh/setup-bun@')) {
          continue
        }
        expect(step.with['bun-version-file'], file).toBe('config/.bun-version')
        expect(step.with['bun-version'], file).toBeUndefined()
      }
    }
  }
})

it('checks formatting over the same tree the local format script writes', () => {
  const check = steps.find((step) => step.name === 'Check formatting')
  const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
  expect(check.run.replace('node node_modules/oxfmt/bin/oxfmt', 'oxfmt')).toBe(
    manifest.scripts.format.replace('--write', '--check')
  )
})

it('keeps the Bun anti-slop scan aligned with the local audit', () => {
  const audit = steps.find((step) => step.name === 'Reject low-evidence patterns')
  const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
  const localCommand = manifest.scripts['audit:anti-slop'].split('&&').at(-1).trim()
  expect(audit.run.trim().split('\n')[0]).toBe('node config/scripts/sync-anti-slop-plugin.mjs')
  expect(audit.run.trim().split('\n').at(-1)).toBe(localCommand)
})

it('requires physical preflight success before publishing shards and admitting consumers', () => {
  const join = steps.findIndex((step) => step.wait === 'unit-plan')
  const upload = steps.findIndex((step) => step.uses === 'actions/upload-artifact@v7')
  expect(join).toBeGreaterThan(compilerJoin)
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

it.each([
  { changed: ['LICENSE'], static_analysis: false, typecheck: false, mobile_dependencies: false },
  { changed: ['README.md'], static_analysis: true, typecheck: false, mobile_dependencies: false },
  {
    changed: ['mobile/src/App.tsx'],
    static_analysis: true,
    typecheck: false,
    mobile_dependencies: true
  },
  {
    changed: ['cloud/apps/relay/Dockerfile'],
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
  expect(runInNewContext(compiler.env.PREFLIGHT_PHASE_SELECTED.slice(3, -2), { needs })).toBe(
    expected.typecheck
  )
  expect(scope.test).toBe(expected.typecheck)
})

it.skipIf(process.platform === 'win32')(
  'exits background guards only when their selected phase cannot run',
  async () => {
    for (const step of steps.filter((step) => step.background)) {
      const guard = step.run.split('\n')[0]
      for (const [selected, priorSuccess, expected] of [
        ['false', 'true', 0],
        ['true', 'false', 0],
        ['true', 'true', 23]
      ]) {
        const result = await runProcess({
          program: 'bash',
          args: ['-e', '-c', `${guard}\nexit 23`],
          env: {
            ...process.env,
            ORCA_BACKGROUND_LAUNCH: '1',
            PREFLIGHT_PHASE_SELECTED: selected,
            PREFLIGHT_PRIOR_SUCCESS: priorSuccess
          },
          timeoutMs: 10_000
        })
        expect(result.code, `${step.id}: selected=${selected}, prior=${priorSuccess}`).toBe(
          expected
        )
      }
    }
  }
)

it('shares import analysis without dropping either boundary gate', () => {
  const imports = steps.find((step) => step.id === 'process-host-imports')
  expect(imports.run).toContain('bun config/scripts/check-import-boundaries.mjs')
  expect(steps.some((step) => step.name === 'Check compatibility-folder imports')).toBe(false)
  expect(steps.find((step) => step.name === 'Verify localization coverage').run).toBe(
    'bun config/scripts/audit-localization-coverage.mjs --check'
  )
})

it('prepares an isolated Node 18 executable before the existing Node 24 dependency installs', () => {
  const setup = steps.find((step) => step.id === 'node18_runtime')
  const capture = steps.find((step) => step.id === 'node18_executable')
  const selected = "needs.code_paths.outputs.managed_hook_node18 == 'true'"
  expect(setup.uses).toBe('actions/setup-node@v6')
  expect(setup.if).toBe(selected)
  expect(setup.with).toEqual({ 'node-version': '18', 'package-manager-cache': false })
  expect(setup['continue-on-error']).toBe(true)
  expect(capture['continue-on-error']).toBe(true)
  expect(capture.run).toBe(`node -p '"executable=" + process.execPath' >> "$GITHUB_OUTPUT"`)
  expect(steps.indexOf(capture)).toBeGreaterThan(steps.indexOf(setup))
  for (const install of steps.filter(
    (step) => step.uses === './.github/actions/install-node-dependencies'
  )) {
    expect(steps.indexOf(install)).toBeGreaterThan(steps.indexOf(capture))
    expect(install.with['node-version']).toBe('24')
    expect(install['continue-on-error']).toBeUndefined()
  }
  for (const outcome of ['success', 'failure', 'cancelled', 'skipped', '', undefined]) {
    expect(
      runInNewContext(capture.if, {
        needs: { code_paths: { outputs: { managed_hook_node18: 'true' } } },
        steps: { node18_runtime: { outcome } }
      })
    ).toBe(outcome === 'success')
  }
  const bun = steps.filter((step) => step.uses?.startsWith('oven-sh/setup-bun@'))
  expect(bun).toHaveLength(1)
  expect(bun[0].if).toBeUndefined()
})

it('runs the unchanged Node 18 smoke after every Node 24 step and preserves its required result', () => {
  const smoke = steps.at(-1)
  const receipt = workflow.jobs.managed_hook_node18
  expect(smoke.id).toBe('managed_hook_node18')
  expect(smoke.if).toBe("success() && needs.code_paths.outputs.managed_hook_node18 == 'true'")
  expect(smoke.env.NODE18_EXECUTABLE).toBe('${{ steps.node18_executable.outputs.executable }}')
  expect(smoke.env.ORCA_BACKGROUND_LAUNCH).toBe('1')
  expect(smoke.run.trim().split('\n')).toEqual([
    'test -n "$NODE18_EXECUTABLE"',
    '"$NODE18_EXECUTABLE" config/scripts/smoke-process-host-node18.mjs'
  ])
  expect(smoke['continue-on-error']).toBe(true)
  expect(preflight['continue-on-error']).toBeUndefined()
  expect(preflight.outputs.managed_hook_node18).toBe('${{ steps.managed_hook_node18.outcome }}')
  for (const background of steps.filter((step) => step.background)) {
    const joined = steps.findIndex((step) =>
      Array.isArray(step.wait) ? step.wait.includes(background.id) : step.wait === background.id
    )
    expect(joined, background.id).toBeGreaterThan(steps.indexOf(background))
    expect(joined, background.id).toBeLessThan(steps.indexOf(smoke))
  }
  expect(receipt.name).toBe('managed hooks on Node 18')
  expect(receipt['runs-on']).toBe('ubuntu-slim')
  expect(receipt.steps).toHaveLength(1)
  expect(receipt.steps[0].uses).toBeUndefined()
  expect(receipt.steps[0].env.MANAGED_HOOK_NODE18).toBe(
    '${{ needs.preflight.outputs.managed_hook_node18 }}'
  )
  expect(receipt['continue-on-error']).toBeUndefined()
  expect(receipt.steps[0]['continue-on-error']).toBeUndefined()
})

it.skipIf(process.platform === 'win32')(
  'fails the smoke for a missing captured executable and requires actual success in the receipt',
  async () => {
    const smoke = steps.at(-1)
    const receipt = workflow.jobs.managed_hook_node18.steps[0]
    const cases = [
      [smoke.run, 'NODE18_EXECUTABLE', '', 1],
      ...['success', 'failure', 'cancelled', 'skipped', '', 'unknown'].map((outcome) => [
        receipt.run,
        'MANAGED_HOOK_NODE18',
        outcome,
        outcome === 'success' ? 0 : 1
      ])
    ]
    for (const [script, variable, value, expected] of cases) {
      const result = await runProcess({
        program: 'bash',
        args: ['-e', '-c', script],
        env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1', [variable]: value },
        timeoutMs: 10_000
      })
      expect(result.code, `${variable}=${value}: ${result.stderr}`).toBe(expected)
    }
  }
)
