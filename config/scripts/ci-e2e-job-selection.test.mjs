import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { parse } from 'yaml'
import { runProcess } from '../../src/shared/child-process/run-process'
import {
  classifyE2eJobs,
  DEDICATED_E2E_SPECS,
  DOCKER_SSH_E2E_SPECS,
  LOCALHOST_SSH_E2E_SPEC,
  NATIVE_IME_E2E_SPEC,
  NODE_NETWORK_E2E_SPEC,
  selectGeneralE2eSpecs
} from './ci-e2e-job-selection.mjs'
import { selectPrE2eSpecs } from './pr-e2e-source-routing.mjs'

const workflow = parse(readFileSync('.github/workflows/e2e.yml', 'utf8'))
const prWorkflow = parse(readFileSync('.github/workflows/pr.yml', 'utf8'))
const classify = (specs, ssh = 'false') => classifyE2eJobs(JSON.stringify(specs), ssh)

it('skips the general consumer only when every requested spec has a dedicated owner', () => {
  for (const spec of DEDICATED_E2E_SPECS) {
    expect(classify([spec]).e2e_run_changed, spec).toBe(false)
  }
  expect(classify(DEDICATED_E2E_SPECS).e2e_run_changed).toBe(false)
  const future = 'tests/e2e/future-unclassified.spec.ts'
  expect(classify([future])).toEqual({ e2e_run_changed: true, e2e_needs_build: true })
  expect(selectGeneralE2eSpecs([...DEDICATED_E2E_SPECS, future])).toEqual([future])
  expect(classify([...DEDICATED_E2E_SPECS, future]).e2e_run_changed).toBe(true)
})

it('keeps Electron build and native prerequisites for every consumer requiring them', () => {
  for (const spec of [...DOCKER_SSH_E2E_SPECS, LOCALHOST_SSH_E2E_SPEC]) {
    expect(classify([spec]), spec).toEqual({
      e2e_run_changed: false,
      e2e_needs_build: true
    })
  }
  for (const spec of [NODE_NETWORK_E2E_SPEC, NATIVE_IME_E2E_SPEC]) {
    expect(classify([spec]), spec).toEqual({
      e2e_run_changed: false,
      e2e_needs_build: false
    })
    expect(classify([spec], 'true').e2e_needs_build).toBe(true)
  }
  expect(workflow.jobs['ssh-browser-network-route'].needs).toBeUndefined()
  for (const name of ['e2e', 'changed-e2e', 'ssh-docker-watcher-isolation', 'ssh-localhost']) {
    expect(workflow.jobs[name].needs, name).toEqual(['build', 'prepare-native-cache'])
  }
})

it('retains allocations when selection or SSH evidence is incomplete', () => {
  for (const input of ['', '[]', 'null', '{}', '[null]', '[""]', 'malformed']) {
    expect(classifyE2eJobs(input), input).toEqual({
      e2e_run_changed: true,
      e2e_needs_build: true
    })
  }
  expect(classify([NODE_NETWORK_E2E_SPEC], '').e2e_needs_build).toBe(true)
})

it('preserves the requested specs across source-routed and mixed selections', () => {
  for (const files of [
    ['src/main/ssh/connection.ts'],
    ['src/main/browser/ssh-browser-network-execution-route.ts'],
    ['src/main/agent-hooks/server.ts'],
    ['src/shared/terminal-unicode-provider.ts'],
    ['tests/e2e/ssh-localhost.spec.ts', 'tests/e2e/future-unclassified.spec.ts']
  ]) {
    const specs = selectPrE2eSpecs(files)
    const general = selectGeneralE2eSpecs(specs)
    const dedicated = specs.filter((spec) => DEDICATED_E2E_SPECS.includes(spec))
    expect([...general, ...dedicated].sort(), files.join(', ')).toEqual(specs)
    expect(new Set([...general, ...dedicated]).size).toBe(specs.length)
  }
})

it('applies allocation hints only to PRs and retains other callers and full references', () => {
  for (const name of ['run_changed_e2e', 'needs_build']) {
    expect(workflow.on.workflow_call.inputs[name]).toMatchObject({
      type: 'boolean',
      required: false,
      default: true
    })
  }
  for (const name of ['build', 'prepare-native-cache']) {
    expect(workflow.jobs[name].if).toBe(
      "inputs.test_files == '' || github.event_name != 'pull_request' || inputs.needs_build"
    )
  }
  expect(workflow.jobs.e2e.if).toBe("inputs.test_files == ''")
  const changed = workflow.jobs['changed-e2e']
  expect(changed.if).toContain("github.event_name != 'pull_request' || inputs.run_changed_e2e")
  const command = changed.steps.find((step) => step.name === 'Run changed E2E specs').run
  expect(command).toContain('node config/scripts/ci-e2e-job-selection.mjs >')
  expect(command).not.toContain('mapfile -t TEST_FILES < <(')
  const fallback = [...command.matchAll(/\. != "([^"]+)"/g)].map((match) => match[1])
  expect(fallback).toEqual(DEDICATED_E2E_SPECS)
})

it('publishes conservative hints for malformed evidence and refuses a malformed consumer list', async () => {
  const program = 'config/scripts/ci-e2e-job-selection.mjs'
  const consumer = await runProcess({
    program: process.execPath,
    args: [program],
    input: 'malformed',
    timeoutMs: 10000
  })
  expect(consumer.code).not.toBe(0)
  const hints = await runProcess({
    program: process.execPath,
    args: [program, '--job-outputs'],
    input: 'malformed',
    timeoutMs: 10000
  })
  expect(hints.code, hints.stderr).toBe(0)
  expect(hints.stdout).toBe('e2e_run_changed=true\ne2e_needs_build=true\n')
})

it('classifies PR consumers in the existing detector and passes conservative allocation hints', () => {
  const detector = prWorkflow.jobs.code_paths
  expect(detector.steps[0].with['sparse-checkout']).toContain(
    '/config/scripts/ci-e2e-job-selection.mjs'
  )
  for (const name of ['e2e_run_changed', 'e2e_needs_build']) {
    expect(detector.outputs[name]).toBe(`\${{ steps.e2e_filter.outputs.${name} }}`)
  }
  const command = detector.steps.find((step) => step.id === 'e2e_filter').run
  expect(command).toContain('E2E_SSH_SOURCE_CHANGED="$SSH_SOURCE_CHANGED"')
  expect(command).toContain('ci-e2e-job-selection.mjs --job-outputs >> "$GITHUB_OUTPUT"')
  expect(prWorkflow.jobs.e2e.with.run_changed_e2e).toBe(
    "${{ needs.code_paths.outputs.e2e_run_changed != 'false' }}"
  )
  expect(prWorkflow.jobs.e2e.with.needs_build).toBe(
    "${{ needs.code_paths.outputs.e2e_needs_build != 'false' }}"
  )
})

it('runs remaining SSH tests after real failures and stops them when a run is cancelled', () => {
  const steps = workflow.jobs['ssh-docker-watcher-isolation'].steps
  expect(steps.find((step) => step.name === 'Run remaining Docker SSH E2E').if).toBe('!cancelled()')
  expect(
    steps.find((step) => step.name === 'Run Docker SSH terminal parking + startup readiness E2E').if
  ).toBe('!cancelled() && matrix.shard == 1')
  for (const step of steps.filter((step) => step.name?.startsWith('Keep '))) {
    expect(step.if).toContain('always()')
  }
})

it.each([
  'src/main/runtime/rpc/methods/terminal/terminal-multiplex-input-delivery.ts',
  'src/renderer/src/runtime/remote-terminal-input-receipts.ts',
  'src/renderer/src/components/terminal-pane/remote-runtime-pty-transport.ts'
])('routes input delivery faults from %s', (path) => {
  expect(selectPrE2eSpecs([path])).toContain('tests/e2e/ssh-orcad-half-open-input.spec.ts')
})
