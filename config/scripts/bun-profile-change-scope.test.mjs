import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import {
  classifyBunProfileChanges,
  collectBunProfileInputs,
  discoverBunProfileTests
} from './bun-profile-change-scope.mjs'
import { bunProfileTestPaths } from './bun-profile-test-paths.mjs'
import { ORCAD_CHILD_ENTRY_POINTS } from './orcad-entry-build.mjs'

const temporaryDirs = []
afterEach(() => {
  for (const root of temporaryDirs.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function moduleTree(files) {
  const root = mkdtempSync(join(tmpdir(), 'bun-profile-scope-'))
  temporaryDirs.push(root)
  for (const [file, source] of Object.entries(files)) {
    const path = join(root, file)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, source)
  }
  return root
}

it('follows static imports, re-exports, dynamic imports and require without executing source', async () => {
  const root = moduleTree({
    'entry.ts': `import './first'; export * from './exports'; import('./dynamic'); require('./required'); throw Error('never execute')`,
    'first.ts': `import './nested/leaf'`,
    'exports.ts': 'export const value = 1',
    'dynamic.ts': 'export const value = 2',
    'required.ts': 'module.exports = 3',
    'nested/leaf.ts': 'export const value = 4',
    'unrelated.ts': 'throw Error("unrelated")'
  })
  const inputs = await collectBunProfileInputs({ root, entryPoints: ['entry.ts'] })
  expect([...inputs].sort()).toEqual([
    'dynamic.ts',
    'entry.ts',
    'exports.ts',
    'first.ts',
    'nested/leaf.ts',
    'required.ts'
  ])
})

it('runs the matrix when a dependency is deleted or graph analysis fails', async () => {
  const root = moduleTree({ 'entry.ts': `import './deleted'` })
  const result = await classifyBunProfileChanges(['deleted.ts'], () =>
    collectBunProfileInputs({ root, entryPoints: ['entry.ts'] })
  )
  expect(result.shouldRun).toBe(true)
  expect(result.reason).toContain('Dependency graph unavailable')
  expect((await classifyBunProfileChanges([])).shouldRun).toBe(true)
})

it.each([
  ['tests/e2e/daemon-running-work-probe.unit.test.ts'],
  ['config/scripts/zip-extractor-command.test.mjs'],
  ['config/scripts/zip-extractor-command.test.mjs', 'config/scripts/renamed-command.test.mjs']
])(
  'runs deleted or renamed selected tests even when absent from the graph: %j',
  async (...files) => {
    expect((await classifyBunProfileChanges(files, async () => new Set())).shouldRun).toBe(true)
  }
)

it.each([
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  '.npmrc',
  'tsconfig.json',
  'config/tsconfig.node.json',
  'config/patches/node-pty@1.1.0.patch',
  'native/windows-registry/src/addon.cc',
  '.github/actions/install-node-dependencies/action.yml',
  '.github/workflows/bun-profile-tests.yml',
  'src/main/persistence/profile-state/new-worker.ts'
])('always selects build, native and dynamically opened inputs: %s', async (file) => {
  expect((await classifyBunProfileChanges([file], async () => new Set())).shouldRun).toBe(true)
})

describe('the actual Bun build and profile-test dependency graph', () => {
  let inputs
  beforeAll(async () => {
    inputs = await collectBunProfileInputs()
  }, 60_000)

  it.each([
    'config/scripts/ci-shard-timings.json',
    'config/scripts/mobile-web-app-terminal-render.test.mjs',
    'src/main/ssh/ssh-relay-upload-stage-commands.test.ts',
    'src/main/menu/register-app-menu.ts'
  ])('skips unrelated work: %s', async (file) => {
    expect((await classifyBunProfileChanges([file], async () => inputs)).shouldRun).toBe(false)
  })

  it.each([
    ...Object.values(ORCAD_CHILD_ENTRY_POINTS),
    'src/shared/keybindings/definitions-core-1.ts',
    'src/main/runtime/orca-runtime.ts',
    'src/main/windows/windows-process-table.ts',
    'src/main/worker-thread-entry-path.ts',
    'config/scripts/zip-extractor-command.mjs',
    'config/scripts/windows-process-tree-gyp-rebuild.mjs',
    'config/scripts/profile-state-worker-smoke.mjs',
    'config/scripts/vitest-host-ports-setup.ts',
    'tests/e2e/daemon-running-work-probe.unit.test.ts'
  ])('retains the full matrix for a real runtime, worker or test input: %s', async (file) => {
    expect(inputs.has(file)).toBe(true)
    expect((await classifyBunProfileChanges([file], async () => inputs)).shouldRun).toBe(true)
  })

  it('retains all selected tests and uses the same selectors as the Bun runner', () => {
    const tests = discoverBunProfileTests()
    expect(tests.length).toBeGreaterThan(80)
    expect(tests.every((file) => inputs.has(file))).toBe(true)
    expect(
      bunProfileTestPaths().every((selector) => tests.some((file) => file.includes(selector)))
    ).toBe(true)
    const runner = readFileSync(new URL('./run-bun-profile-tests.mjs', import.meta.url), 'utf8')
    expect(runner).toContain('testArgs.length > 0 ? testArgs : bunProfileTestPaths({ artifact })')
  })
})

it('keeps all ten platform jobs and runs them when detection is skipped or fails', () => {
  const workflow = parse(
    readFileSync(new URL('../../.github/workflows/bun-profile-tests.yml', import.meta.url), 'utf8')
  )
  expect(workflow.on).toHaveProperty('workflow_dispatch')
  expect(workflow.jobs.changes.if).toBe("github.event_name == 'pull_request'")
  expect(workflow.jobs.changes.steps[0].with['fetch-depth']).toBe(2)
  expect(workflow.jobs.changes.steps[0].with['persist-credentials']).toBe(false)
  const detect = workflow.jobs.changes.steps.find((step) => step.id === 'scope')
  expect(detect.run).toContain('git diff --name-only --no-renames -z HEAD^1 HEAD')
  let count = 0
  for (const jobName of ['persistence', 'linux_glibc_floor', 'linux_musl']) {
    const job = workflow.jobs[jobName]
    expect(job.needs).toBe('changes')
    expect(job.if).toBe("${{ !cancelled() && needs.changes.outputs.should_run != 'false' }}")
    count += job.strategy.matrix.os.length
  }
  expect(count).toBe(10)
})
