import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { parse } from 'yaml'
import { runProcess } from '@orca/process-host'
import {
  classifyE2eJobs,
  DEDICATED_E2E_SPECS,
  generalE2eShards,
  NATIVE_IME_E2E_SPEC,
  NODE_NETWORK_E2E_SPEC,
  selectGeneralE2eSpecs
} from './ci-e2e-job-selection.mjs'
import { selectPrE2eSpecs } from './pr-e2e-source-routing.mjs'

const workflow = parse(readFileSync('.github/workflows/e2e.yml', 'utf8'))
const classify = (specs) => classifyE2eJobs(JSON.stringify(specs))

it('scales broad general selections without charging extra VMs for duplicate or dedicated specs', () => {
  const specs = Array.from({ length: 51 }, (_, index) => `tests/e2e/example-${index}.spec.ts`)
  expect(generalE2eShards(JSON.stringify(specs.slice(0, 25)))).toEqual(['1/1'])
  expect(generalE2eShards(JSON.stringify([...specs, ...specs, ...DEDICATED_E2E_SPECS]))).toEqual([
    '1/3',
    '2/3',
    '3/3'
  ])
  expect(generalE2eShards(JSON.stringify(['tests/e2e/ssh-orcad-example.spec.ts']))).toEqual(['1/1'])
  expect(generalE2eShards('')).toEqual(['1/1'])
  expect(generalE2eShards('[]')).toEqual(['1/1'])
  expect(
    generalE2eShards(JSON.stringify(Array.from({ length: 400 }, (_, i) => `${i}.spec.ts`)))
  ).toHaveLength(14)
  for (const invalid of ['malformed', 'null', '{}', '[null]', '[""]']) {
    expect(() => generalE2eShards(invalid)).toThrow()
  }
})

it('skips the general consumer only when every requested spec has a dedicated owner', () => {
  for (const spec of DEDICATED_E2E_SPECS) {
    expect(classify([spec]).e2e_run_changed, spec).toBe(false)
  }
  expect(classify(DEDICATED_E2E_SPECS).e2e_run_changed).toBe(false)
  const future = 'tests/e2e/future-unclassified.spec.ts'
  expect(classify([future])).toEqual({
    e2e_run_changed: true,
    e2e_needs_build: true
  })
  expect(selectGeneralE2eSpecs([...DEDICATED_E2E_SPECS, future])).toEqual([future])
  expect(classify([...DEDICATED_E2E_SPECS, future]).e2e_run_changed).toBe(true)
})

it('keeps Electron build and native prerequisites for every consumer requiring them', () => {
  for (const spec of [NODE_NETWORK_E2E_SPEC, NATIVE_IME_E2E_SPEC]) {
    expect(classify([spec]), spec).toEqual({
      e2e_run_changed: false,
      e2e_needs_build: false
    })
  }
  expect(workflow.jobs['ssh-browser-network-route'].needs).toBeUndefined()
  for (const name of ['e2e', 'changed-e2e']) {
    expect(workflow.jobs[name].needs, name).toEqual(['build'])
  }
})

it('retains allocations when selection evidence is incomplete', () => {
  for (const input of ['', '[]', 'null', '{}', '[null]', '[""]', 'malformed']) {
    expect(classifyE2eJobs(input), input).toEqual({
      e2e_run_changed: true,
      e2e_needs_build: true
    })
  }
})

it('preserves the requested specs across source-routed and mixed selections', () => {
  for (const files of [
    ['src/main/browser/ssh-browser-network-execution-route.ts'],
    ['src/shared/terminal-unicode-provider.ts'],
    [NODE_NETWORK_E2E_SPEC, 'tests/e2e/future-unclassified.spec.ts']
  ]) {
    const specs = selectPrE2eSpecs(files)
    expect(specs.length).toBeGreaterThan(0)
    const general = selectGeneralE2eSpecs(specs)
    const dedicated = specs.filter((spec) => DEDICATED_E2E_SPECS.includes(spec))
    expect([...general, ...dedicated].sort(), files.join(', ')).toEqual(specs)
    expect(new Set([...general, ...dedicated]).size).toBe(specs.length)
  }
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
  expect(hints.stdout).toBe(
    'e2e_run_changed=true\ne2e_needs_build=true\ne2e_ssh_shards=["1/2","2/2"]\n'
  )
})
