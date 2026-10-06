import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import {
  classifyOrcadTerminalSmokeChanges,
  collectOrcadTerminalSmokeInputs
} from './orcad-terminal-smoke-change-scope.mjs'
import { ORCAD_CHILD_ENTRY_POINTS } from './orcad-entry-build.mjs'

it.each([
  'package.json',
  'pnpm-lock.yaml',
  'tsconfig.json',
  'config/tsconfig.cli.json',
  'config/patches/node-pty@1.1.0.patch',
  'native/windows-registry/src/addon.cc',
  'config/scripts/node-pty-job-ownership.cjs',
  '.github/actions/install-node-dependencies/action.yml',
  '.github/workflows/pr.yml',
  'src/cli/deleted-command.ts',
  'src/shared/deleted-contract.ts',
  'src/main/persistence/profile-state/new-worker.ts',
  'resources/licenses/ripgrep/COPYING',
  'config/scripts/runtime-serve-terminal-smoke.test.mjs',
  'config/scripts/orcad-terminal-smoke-change-scope.test.mjs'
])('retains the smoke for build and dynamically opened input changes: %s', async (file) => {
  expect((await classifyOrcadTerminalSmokeChanges([file], async () => new Set())).shouldRun).toBe(
    true
  )
})

it('retains smoke when changed-file evidence or dependency analysis is unavailable', async () => {
  expect((await classifyOrcadTerminalSmokeChanges([])).shouldRun).toBe(true)
  const result = await classifyOrcadTerminalSmokeChanges(['src/main/deleted.ts'], async () => {
    throw new Error('Could not resolve deleted dependency')
  })
  expect(result.shouldRun).toBe(true)
  expect(result.reason).toContain('Dependency graph unavailable')
})

describe('the actual terminal smoke dependency graph', () => {
  let inputs
  beforeAll(async () => {
    inputs = await collectOrcadTerminalSmokeInputs()
  }, 60_000)

  it.each([
    ...Object.values(ORCAD_CHILD_ENTRY_POINTS),
    'src/main/runtime/orca-runtime.ts',
    'src/main/windows/windows-process-table.ts',
    'src/main/worker-thread-entry-path.ts',
    'src/cli/index.ts',
    'config/scripts/runtime-serve-terminal-smoke.mjs',
    'config/scripts/build-orcad-node.mjs',
    'config/scripts/build-orcad.mjs',
    'config/scripts/profile-state-worker-smoke.mjs',
    'config/scripts/install-dev-cli.mjs',
    'config/scripts/verify-cli-bin.mjs',
    'config/scripts/node-server-change-scope.mjs'
  ])('retains the runtime, CLI, build or smoke dependency: %s', async (file) => {
    expect(inputs.has(file)).toBe(true)
    expect((await classifyOrcadTerminalSmokeChanges([file], async () => inputs)).shouldRun).toBe(
      true
    )
  })

  it.each([
    'src/renderer/src/components/Example.tsx',
    'src/main/menu/register-app-menu.ts',
    'config/scripts/ci-shard-timings.json',
    '.github/workflows/e2e.yml',
    'docs/reference/ci-runner-efficiency.md'
  ])('skips unrelated inputs: %s', async (file) => {
    expect((await classifyOrcadTerminalSmokeChanges([file], async () => inputs)).shouldRun).toBe(
      false
    )
  })

  it('retains a removed source path when a file is renamed outside the CLI tree', async () => {
    expect(
      (
        await classifyOrcadTerminalSmokeChanges(
          ['src/cli/deleted-command.ts', 'docs/moved-command.ts'],
          async () => inputs
        )
      ).shouldRun
    ).toBe(true)
  })
})

it('only skips the unchanged smoke after a successful diff and dependency analysis', () => {
  const workflow = parse(
    readFileSync(new URL('../../.github/workflows/pr.yml', import.meta.url), 'utf8')
  )
  const step = workflow.jobs.preflight.steps.find(
    (candidate) => candidate.name === 'Boot orcad and round-trip a terminal'
  )
  expect(step.env).toEqual({
    BASE_SHA: '${{ github.event.pull_request.base.sha }}',
    ORCA_BACKGROUND_LAUNCH: '1'
  })
  // See the localization gate: HEAD^1 removes the merge-base computation, so a shallow checkout
  // is enough and the payload head SHA is unused.
  expect(step.run).toContain('node config/scripts/git-pull-request-diff-base.mjs "$BASE_SHA"')
  expect(step.run).toContain('git diff --name-only --no-renames -z "$DIFF_BASE" HEAD')
  expect(step.run).not.toContain('--diff-filter')
  expect(step.run).toContain('&& [ "$scope" = false ]; then')
  expect(step.run).toMatch(/else\s+pnpm run smoke:orcad-terminal\s+fi/)
})
