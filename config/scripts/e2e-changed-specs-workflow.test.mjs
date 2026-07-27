import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { selectChangedE2eSpecs } from './select-changed-e2e-specs.mjs'

const projectDir = resolve(import.meta.dirname, '../..')
const workflowPath = join(projectDir, '.github/workflows/e2e-changed-specs.yml')
const selectorPath = join(projectDir, 'config/scripts/select-changed-e2e-specs.mjs')

function readWorkflow() {
  return parse(readFileSync(workflowPath, 'utf8'))
}

function runSelector(stdin) {
  return execFileSync('node', [selectorPath], { input: stdin, encoding: 'utf8' })
}

describe('select-changed-e2e-specs', () => {
  it('keeps changed E2E specs and drops everything else', () => {
    expect(
      selectChangedE2eSpecs([
        'src/main/ipc/preflight.ts',
        'tests/e2e/onboarding.spec.ts',
        'tests/e2e/helpers/orca-app.ts',
        'tests/unit/foo.spec.ts',
        'tests/e2e/computer-mac.e2e.ts',
        'docs/e2e.md'
      ])
    ).toEqual(['tests/e2e/onboarding.spec.ts'])
  })

  it('accepts specs in nested E2E directories', () => {
    expect(selectChangedE2eSpecs(['tests/e2e/regression/tab-close.spec.ts'])).toEqual([
      'tests/e2e/regression/tab-close.spec.ts'
    ])
  })

  it('deduplicates and sorts so the run order does not depend on the API page order', () => {
    expect(
      selectChangedE2eSpecs([
        'tests/e2e/zeta.spec.ts',
        'tests/e2e/alpha.spec.ts',
        'tests/e2e/zeta.spec.ts'
      ])
    ).toEqual(['tests/e2e/alpha.spec.ts', 'tests/e2e/zeta.spec.ts'])
  })

  it('drops paths a fork PR could weaponize into the test command', () => {
    // Why: these become argv for the shell-invoked `pnpm run test:e2e`, and a
    // fork PR picks its own filenames.
    expect(
      selectChangedE2eSpecs([
        'tests/e2e/a.spec.ts; rm -rf /',
        'tests/e2e/$(id).spec.ts',
        'tests/e2e/`id`.spec.ts',
        'tests/e2e/a b.spec.ts',
        'tests/e2e/--shard=1/2.spec.ts',
        'tests/e2e/../../etc/passwd.spec.ts',
        '../tests/e2e/outside.spec.ts',
        '/tests/e2e/absolute.spec.ts'
      ])
    ).toEqual([])
  })

  it('emits nothing at all when no spec changed, so the workflow can test for empty', () => {
    expect(runSelector('src/main/index.ts\nREADME.md\n')).toBe('')
  })

  it('emits one newline-terminated path per selected spec', () => {
    expect(runSelector('tests/e2e/b.spec.ts\nsrc/main/index.ts\ntests/e2e/a.spec.ts\n')).toBe(
      'tests/e2e/a.spec.ts\ntests/e2e/b.spec.ts\n'
    )
  })
})

describe('e2e-changed-specs workflow', () => {
  it('runs on every pull request so it can be made a required check', () => {
    const workflow = readWorkflow()

    // Why: a `paths:` filter would make the check simply not appear on PRs that
    // touch no spec, and a required check that never reports blocks the merge
    // box forever. Selection happens inside the job instead.
    expect(workflow.on.pull_request.paths).toBeUndefined()
    expect(workflow.on.pull_request['paths-ignore']).toBeUndefined()
    expect(workflow.on.pull_request.types).toEqual([
      'opened',
      'synchronize',
      'reopened',
      'ready_for_review'
    ])
  })

  it('asks the API for the changed files instead of diffing a shallow checkout', () => {
    const workflow = readWorkflow()
    const steps = workflow.jobs['changed-specs'].steps
    const select = steps.find((step) => step.id === 'select')

    expect(select.run).toContain('--paginate')
    expect(select.run).toContain('/pulls/${{ github.event.pull_request.number }}/files')
    // Why: a spec deleted by the PR must not be handed to Playwright.
    expect(select.run).toContain('select(.status != "removed")')
    expect(select.run).toContain('config/scripts/select-changed-e2e-specs.mjs')
    expect(workflow.jobs['changed-specs'].permissions).toEqual({
      contents: 'read',
      'pull-requests': 'read'
    })
  })

  it('skips the build when no spec changed', () => {
    const workflow = readWorkflow()
    const steps = workflow.jobs['changed-specs'].steps
    const afterSelect = steps.slice(steps.findIndex((step) => step.id === 'select') + 1)

    // Why: the cheap path is the common one — no toolchain, no pnpm install, no
    // Electron build for a PR that changed no spec. Only the failure-gated
    // trace upload is exempt, and it has nothing to collect on that path.
    const workSteps = afterSelect.filter(
      (step) => !step.uses?.startsWith('actions/upload-artifact')
    )
    expect(workSteps.length).toBeGreaterThan(0)
    for (const step of workSteps) {
      expect(step.if).toContain("steps.select.outputs.specs != ''")
    }
  })

  it('runs the selected specs the same way the scheduled suite runs its shards', () => {
    const workflow = readWorkflow()
    const run = workflow.jobs['changed-specs'].steps.find((step) => step.id === 'run')
    const scheduled = parse(readFileSync(join(projectDir, '.github/workflows/e2e.yml'), 'utf8'))
    const scheduledRun = scheduled.jobs.e2e.steps.find((step) =>
      step.run?.includes('pnpm run test:e2e')
    ).run

    for (const token of [
      'xvfb-run --auto-servernum',
      'SKIP_BUILD=1',
      'ORCA_E2E_FORWARD_APP_LOGS=1',
      'pnpm run test:e2e'
    ]) {
      expect(scheduledRun).toContain(token)
      expect(run.run).toContain(token)
    }
    // Why: a spec whose tests are all @headful is filtered out by the
    // electron-headless project, and "no tests ran" must not fail the gate.
    expect(run.run).toContain('--pass-with-no-tests')
    // Why: paths reach the command as an array, never spliced into the string.
    expect(run.run).toContain('"${SPECS[@]}"')
    expect(run.shell).toBe('bash')
  })

  it('uploads traces when the gate fails', () => {
    const workflow = readWorkflow()
    const upload = workflow.jobs['changed-specs'].steps.find((step) =>
      step.uses?.startsWith('actions/upload-artifact')
    )

    expect(upload.if).toContain('failure()')
    expect(upload.with.path).toBe('test-results/')
  })
})
