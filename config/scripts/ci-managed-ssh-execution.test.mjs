import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { parse } from 'yaml'
import { runProcess } from '@orca/process-host'
import { managedSshShards, MANAGED_SSH_E2E_SPEC_PREFIX } from './ci-e2e-job-selection.mjs'
import { compileAggregateExpression } from './pr-aggregate-gate-context.mjs'
import { selectPrE2eSpecs } from './pr-e2e-source-routing.mjs'

const workflow = parse(readFileSync('.github/workflows/e2e.yml', 'utf8'))
const prWorkflow = parse(readFileSync('.github/workflows/pr.yml', 'utf8'))
const lane = workflow.jobs['orcad-ssh-docker']
const command = lane.steps.find(
  (step) => step.name === 'Run managed SSH specs on a Docker host'
).run
const selector = readFileSync('config/scripts/ci-e2e-job-selection.mjs', 'utf8')
const small = ['tests/e2e/ssh-orcad-open-in-owner.spec.ts', 'tests/e2e/ssh-orcad-idle-exit.spec.ts']
const directories = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

it('uses one PR shard for at most two selected files and preserves the full default', () => {
  const caller = compileAggregateExpression(prWorkflow.jobs.e2e.with.managed_ssh_shards)
  const matrix = compileAggregateExpression(lane.strategy.matrix.shard, ['inputs'])
  for (const [specs, expected] of [
    [[small[0]], ['1/1']],
    [small, ['1/1']],
    [
      [...small, 'tests/e2e/ssh-orcad-workspace-tools.spec.ts'],
      ['1/2', '2/2']
    ],
    [[MANAGED_SSH_E2E_SPEC_PREFIX], ['1/2', '2/2']]
  ]) {
    const shards = caller({
      needs: {
        code_paths: {
          outputs: {
            e2e_ssh_shards: JSON.stringify(managedSshShards(JSON.stringify(specs)))
          }
        }
      }
    }).coerceString()
    expect(
      matrix({ inputs: { managed_ssh_shards: shards } })
        .values()
        .map((item) => item.value)
    ).toEqual(expected)
  }
  expect(
    matrix({ inputs: {} })
      .values()
      .map((item) => item.value)
  ).toEqual(['1/2', '2/2'])
})

it('keeps shared SSH fixtures on the full suite but excludes the experimental sidebar spec', () => {
  for (const file of [
    'tests/e2e/helpers/orcad-managed-workspace.ts',
    'tests/e2e/helpers/paired-host-terminal.ts',
    '.github/workflows/e2e.yml'
  ]) {
    expect(selectPrE2eSpecs([file])).toContain(MANAGED_SSH_E2E_SPEC_PREFIX)
  }
  for (const file of [
    'tests/e2e/ssh-orcad-phone-feed-list.spec.ts',
    'tests/e2e/helpers/phone-feed-list.ts',
    'tests/e2e/helpers/sidebar-inputs-build.ts',
    'src/shared/sidebar-list/sidebar-feed-list.ts'
  ]) {
    expect(
      selectPrE2eSpecs([file]).some((spec) => spec.startsWith(MANAGED_SSH_E2E_SPEC_PREFIX)),
      file
    ).toBe(false)
  }
})

async function execute(input, version = 'current') {
  const directory = mkdtempSync(join(tmpdir(), 'orca-ssh-selection-'))
  directories.push(directory)
  const bin = join(directory, 'bin')
  mkdirSync(bin)
  const moduleDir = join(directory, 'config', 'scripts')
  mkdirSync(moduleDir, { recursive: true })
  if (version !== 'missing') {
    writeFileSync(
      join(moduleDir, 'ci-e2e-job-selection.mjs'),
      version === 'current' ? selector : 'export const old = true\n'
    )
  }
  writeFileSync(
    join(bin, 'xvfb-run'),
    `#!/usr/bin/env bash
while [ "$#" -gt 0 ] && [ "$1" != pnpm ]; do shift; done
exec "$@"
`,
    { mode: 0o755 }
  )
  const capture = join(directory, 'argv.json')
  writeFileSync(
    join(bin, 'pnpm'),
    `#!/usr/bin/env node
require('node:fs').writeFileSync(process.env.ARGV_CAPTURE, JSON.stringify(process.argv.slice(2)))
`,
    { mode: 0o755 }
  )
  const result = await runProcess({
    program: 'bash',
    args: ['-e', '-o', 'pipefail', '-c', command],
    cwd: directory,
    env: {
      ...process.env,
      PATH: bin + delimiter + process.env.PATH,
      TEST_FILES_JSON: input,
      RUNNER_TEMP: directory,
      ARGV_CAPTURE: capture,
      SHARD: '1/1',
      LAYOUT_OWNER: '',
      SHARD_INDEX: '0'
    },
    timeoutMs: 10000
  })
  return {
    result,
    args: existsSync(capture) ? JSON.parse(readFileSync(capture, 'utf8')) : undefined
  }
}

// The production lane runs Bash on Linux; the stubs never start Docker, Electron, or Xvfb.
describe.skipIf(process.platform === 'win32')('managed SSH workflow command', () => {
  it('passes only the selected SSH files to Playwright, with literal file matching', async () => {
    const { result, args } = await execute(
      JSON.stringify([...small, 'tests/e2e/other.spec.ts', small[0]])
    )
    expect(result.code, result.stderr).toBe(0)
    const filters = args.slice(
      args.indexOf('tests/playwright.config.ts') + 1,
      args.indexOf('--project=electron-headless')
    )
    expect(filters).toHaveLength(2)
    expect(small.map((file) => filters.some((filter) => new RegExp(filter).test(file)))).toEqual([
      true,
      true
    ])
    expect(
      filters.some((filter) => new RegExp(filter).test('tests/e2e/ssh-orcad-open-in-ownerXspecYts'))
    ).toBe(false)
    expect(
      filters.some((filter) => new RegExp(filter).test('tests/e2e/ssh-orcad-unselected.spec.ts'))
    ).toBe(false)
    expect(args).toContain('--shard=1/1')
  })

  it.each(['', JSON.stringify([MANAGED_SSH_E2E_SPEC_PREFIX, small[0]])])(
    'keeps full daily and explicit suite execution for %s',
    async (input) => {
      const { result, args } = await execute(input)
      expect(result.code, result.stderr).toBe(0)
      expect(args).toContain(MANAGED_SSH_E2E_SPEC_PREFIX)
    }
  )

  it.each(['legacy', 'missing'])('keeps compatibility with %s checkout refs', async (version) => {
    const { result, args } = await execute(JSON.stringify(small), version)
    expect(result.code, result.stderr).toBe(0)
    expect(args).toContain(MANAGED_SSH_E2E_SPEC_PREFIX)
  })

  it.each([
    'malformed',
    '[]',
    '[null]',
    JSON.stringify(['tests/e2e/other.spec.ts']),
    JSON.stringify(['tests/e2e/ssh-orcad-../../other.spec.ts'])
  ])('refuses invalid selection before starting Playwright: %s', async (input) => {
    const { result, args } = await execute(input)
    expect(result.code).not.toBe(0)
    expect(args).toBeUndefined()
    expect(managedSshShards(input)).toEqual(['1/2', '2/2'])
  })
})
