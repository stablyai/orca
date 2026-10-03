import { DEDICATED_E2E_SPECS } from './ci-e2e-job-selection.mjs'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'
import { parse } from 'yaml'
import { runProcess } from '../../src/shared/child-process/run-process'

const require = createRequire(import.meta.url)
const root = join(import.meta.dirname, '../..')
const workflow = parse(readFileSync(join(root, '.github/workflows/e2e.yml'), 'utf8'))
const job = workflow.jobs['ssh-docker-watcher-isolation']
const readRunner = (name) => readFileSync(join(root, `config/scripts/${name}.mjs`), 'utf8')
const runnerSpecs = (name) =>
  [...readRunner(name).matchAll(/^    '(tests\/e2e\/[^']+\.spec\.ts)',/gm)].map((match) => match[1])
const runners = [
  'run-ssh-docker-e2e',
  'run-ssh-docker-watcher-isolation-e2e',
  'run-ssh-docker-terminal-parking-e2e'
]

it('gives every removed SSH spec a dedicated owner even for test-only edits', () => {
  const changedRun = workflow.jobs['changed-e2e'].steps.find(
    (step) => step.name === 'Run changed E2E specs'
  ).run
  expect(changedRun).toContain('node config/scripts/ci-e2e-job-selection.mjs')
  const excluded = DEDICATED_E2E_SPECS
  const owned = runners.flatMap(runnerSpecs)
  expect(owned.length).toBeGreaterThan(25)
  expect(new Set(owned).size).toBe(owned.length)
  for (const spec of owned) {
    expect(excluded, spec).toContain(spec)
    expect(job.if, spec).toContain(`contains(inputs.test_files, '${spec}')`)
  }
  expect(excluded.filter((spec) => !owned.includes(spec)).sort()).toEqual([
    'tests/e2e/orcad-serve-mode-switch.spec.ts',
    'tests/e2e/ssh-browser-network-execution-route.docker.unit.test.ts',
    'tests/e2e/ssh-localhost.spec.ts',
    'tests/e2e/ssh-orcad-auto-convert.spec.ts',
    'tests/e2e/terminal-ibus-hangul-native.spec.ts'
  ])
})

it('native Playwright shards preserve every SSH test and project exactly once', async () => {
  const cli = join(dirname(require.resolve('playwright/package.json')), 'cli.js')
  const env = {
    ...process.env,
    ORCA_BACKGROUND_LAUNCH: '1',
    ORCA_E2E_SSH_DOCKER: '1',
    ORCA_E2E_LOCAL_SSH_BROWSER: '1',
    ORCA_E2E_SSH_CLIENT_HOSTED_BROWSER: '1',
    ORCA_E2E_WEB_CLIENT: '1'
  }
  async function discover(extra = []) {
    const result = await runProcess({
      program: process.execPath,
      cwd: root,
      args: [
        cli,
        'test',
        ...runnerSpecs(runners[0]),
        '--config',
        'tests/playwright.config.ts',
        '--project=electron-headless',
        '--project=electron-headful',
        '--workers=1',
        '--list',
        '--reporter=json',
        ...extra
      ],
      env,
      timeoutMs: 30000
    })
    expect(result.code, result.stderr).toBe(0)
    const report = JSON.parse(result.stdout)
    expect(report.errors).toEqual([])
    const ids = []
    function visit(suite) {
      for (const spec of suite.specs ?? []) {
        for (const test of spec.tests) {
          ids.push(`${spec.id}:${test.projectName}`)
        }
      }
      for (const child of suite.suites ?? []) {
        visit(child)
      }
    }
    visit(report)
    return ids
  }
  const full = await discover()
  const sharded = []
  for (const index of job.strategy.matrix.shard) {
    const selected = await discover([`--shard=${index}/4`])
    expect(selected.length).toBeGreaterThan(0)
    sharded.push(...selected)
  }
  expect(full.length).toBeGreaterThanOrEqual(40)
  expect(new Set(sharded).size).toBe(sharded.length)
  expect(sharded.sort()).toEqual(full.sort())
}, 90000)
