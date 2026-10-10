import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import {
  classifyNodeServerChanges,
  collectNodeServerInputs,
  discoverNodeServerTests
} from './node-server-change-scope.mjs'
import { nodeServerTestPaths } from './node-server-test-paths.mjs'
import { ORCAD_CHILD_ENTRY_POINTS } from './orcad-entry-build.mjs'
import { NODE_RUNTIME_PIN } from '../../src/shared/node-runtime-pin.ts'
import { runProcessSync } from '@orca/process-host'
import { NODE_SERVER_RUNNERS } from './node-server-qualification.mjs'

const temporaryDirs = []
afterEach(() => {
  for (const root of temporaryDirs.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function moduleTree(files) {
  const root = mkdtempSync(join(tmpdir(), 'node-server-scope-'))
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
  const inputs = await collectNodeServerInputs({ root, entryPoints: ['entry.ts'] })
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
  const result = await classifyNodeServerChanges(['deleted.ts'], () =>
    collectNodeServerInputs({ root, entryPoints: ['entry.ts'] })
  )
  expect(result.shouldRun).toBe(true)
  expect(result.reason).toContain('Dependency graph unavailable')
  expect((await classifyNodeServerChanges([])).shouldRun).toBe(true)
})

function workspaceTree(imported = '@orca/process-host') {
  const manifest = (name, source) =>
    JSON.stringify({
      name,
      exports: { '.': { 'orca-source': source, default: './dist/index.js' } }
    })
  return moduleTree({
    'entry.ts': `export * from '${imported}'`,
    'pnpm-workspace.yaml': 'packages:\n  - src/packages/*\n',
    'src/packages/process-host/package.json': manifest(
      '@orca/process-host',
      './src/run-process.ts'
    ),
    'src/packages/process-host/src/run-process.ts':
      "import('@orca/byte-buffer'); require('./private'); export const value = 1",
    'src/packages/process-host/src/private.ts': 'module.exports = 2',
    'src/packages/process-host/dist/index.js': "require('./missing-stale-output')",
    'src/packages/byte-buffer/package.json': manifest('@orca/byte-buffer', './src/byte-buffer.ts'),
    'src/packages/byte-buffer/src/byte-buffer.ts': 'export const value = 3',
    'src/packages/unrelated/package.json': manifest('@orca/unrelated', './src/unrelated.ts'),
    'src/packages/unrelated/src/unrelated.ts': 'throw Error("unrelated")'
  })
}

it('tracks workspace source and manifest closures without trusting dist or widening to unrelated packages', async () => {
  const root = workspaceTree()
  const inputs = await collectNodeServerInputs({ root, entryPoints: ['entry.ts'] })
  expect([...inputs].sort()).toEqual([
    'entry.ts',
    'src/packages/byte-buffer/package.json',
    'src/packages/byte-buffer/src/byte-buffer.ts',
    'src/packages/process-host/package.json',
    'src/packages/process-host/src/private.ts',
    'src/packages/process-host/src/run-process.ts'
  ])
  for (const file of [
    'src/packages/process-host/package.json',
    'src/packages/process-host/src/private.ts',
    'src/packages/byte-buffer/src/byte-buffer.ts'
  ]) {
    expect((await classifyNodeServerChanges([file], async () => inputs)).shouldRun).toBe(true)
  }
  expect(
    (
      await classifyNodeServerChanges(
        ['src/packages/unrelated/src/unrelated.ts'],
        async () => inputs
      )
    ).shouldRun
  ).toBe(false)
})

it.each([
  'src/packages/process-host/.gitignore',
  'src/packages/process-host/scripts/build-dist.mjs',
  'src/packages/process-host/tsconfig.json'
])('runs for a change to the process-host build input %s', async (file) => {
  const result = await classifyNodeServerChanges([file], async () => new Set())
  expect(result.shouldRun).toBe(true)
  expect(result.reason).toBe(`Build or CI input changed: ${file}`)
})

it.each(['@orca/unknown', '@orca/process-host/private'])(
  'retains qualification for an unresolved internal package export: %s',
  async (specifier) => {
    const root = workspaceTree(specifier)
    const result = await classifyNodeServerChanges(
      ['src/packages/process-host/src/run-process.ts'],
      () => collectNodeServerInputs({ root, entryPoints: ['entry.ts'] })
    )
    expect(result.shouldRun).toBe(true)
    expect(result.graphUnavailable).toBe(true)
    expect(result.reason).toContain('No public orca-source export')
  }
)

it.each([
  ['tests/e2e/daemon-running-work-probe.unit.test.ts'],
  ['config/scripts/zip-extractor-command.test.mjs'],
  ['config/scripts/zip-extractor-command.test.mjs', 'config/scripts/renamed-command.test.mjs']
])(
  'runs deleted or renamed selected tests even when absent from the graph: %j',
  async (...files) => {
    expect((await classifyNodeServerChanges(files, async () => new Set())).shouldRun).toBe(true)
  }
)

it.each([
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  '.npmrc',
  'tsconfig.json',
  'config/tsconfig.node.json',
  'config/scripts/node-server-qualification.mjs',
  'config/patches/node-pty@1.1.0.patch',
  'native/windows-registry/src/addon.cc',
  '.github/actions/install-node-dependencies/action.yml',
  '.github/actions/restore-pnpm-verification/action.yml',
  '.github/actions/prepare-headless-compiler/action.yml',
  'config/scripts/headless-detector-compiler-cache.mjs',
  'config/scripts/workspace-source-exports.mjs',
  'config/scripts/workspace-source-exports.test.mjs',
  '.github/actions/prepare-native-runtime/action.yml',
  '.github/actions/prepare-orcad-prebuilds/action.yml',
  '.github/workflows/node-server-tests.yml',
  'src/main/persistence/profile-state/new-worker.ts'
])('always selects build, native and dynamically opened inputs: %s', async (file) => {
  expect((await classifyNodeServerChanges([file], async () => new Set())).shouldRun).toBe(true)
})

it('checks ordinary source unit files against actual imports before skipping the matrix', async () => {
  const reachable = 'src/main/persistence/example/used.test.ts'
  const unrelated = 'src/main/persistence/example/unrelated.test.tsx'
  const removed = 'src/main/persistence/example/removed.test.ts'
  const root = moduleTree({
    'entry.ts': `import './${reachable}'; throw Error('never execute')`,
    [reachable]: 'export const value = 1',
    [unrelated]: 'throw Error("never execute unrelated test")'
  })
  const inputs = await collectNodeServerInputs({ root, entryPoints: ['entry.ts'] })
  expect(inputs.has(reachable)).toBe(true)
  expect(inputs.has(unrelated)).toBe(false)
  expect((await classifyNodeServerChanges([reachable], async () => inputs)).shouldRun).toBe(true)
  expect((await classifyNodeServerChanges([unrelated], async () => inputs)).shouldRun).toBe(false)
  expect((await classifyNodeServerChanges([removed], async () => inputs)).shouldRun).toBe(false)
})

it('retains qualification when a removed ordinary unit file breaks an actual import', async () => {
  const removed = 'src/main/persistence/example/removed.test.ts'
  const root = moduleTree({ 'entry.ts': `import './${removed}'` })
  const result = await classifyNodeServerChanges([removed], () =>
    collectNodeServerInputs({ root, entryPoints: ['entry.ts'] })
  )
  expect(result.shouldRun).toBe(true)
  expect(result.graphUnavailable).toBe(true)
  expect(result.reason).toContain('Dependency graph unavailable')
  expect(result.reason).toContain('removed.test.ts')
})

it('requests the graph for an ordinary source unit edit before dependencies are installed', async () => {
  const result = await classifyNodeServerChanges(
    ['src/main/persistence/example/unrelated.test.ts'],
    async () => {
      throw new Error('graph must not run before installation')
    },
    { deferGraph: true }
  )
  expect(result.graphRequired).toBe(true)
  expect(result.shouldRun).toBeUndefined()
})

it.each([
  'src/main/persistence/profile-state/removed.test.ts',
  'src/main/sqlite/removed.test.ts',
  'src/main/orcad/orcad-entry.test.ts',
  'src/main/daemon/pty-subprocess/removed.test.ts',
  'src/main/providers/agent-foreground-process-git-bash.win32.test.ts',
  'config/scripts/node-server-change-scope.test.mjs'
])('forces explicitly protected tests without relying on graph discovery: %s', async (file) => {
  const result = await classifyNodeServerChanges([file], async () => {
    throw new Error('protected test must not require graph analysis')
  })
  expect(result.shouldRun).toBe(true)
  expect(result.graphUnavailable).toBeUndefined()
  expect(result.reason).toBe(`Build or CI input changed: ${file}`)
})

it.each([
  'src/main/persistence/example/worker.ts',
  'src/main/persistence/example/state.fixture.ts',
  'src/main/persistence/example/state.test.ts.fixture',
  'src/main/persistence/example/state.spec.ts',
  'src/main/persistence/example/../state.test.ts',
  'src/main/persistence/example/./state.test.ts',
  '.github/actions/prepare-native-runtime/cache.test.ts'
])(
  'retains prefix protection for production, fixtures and other file conventions: %s',
  async (file) => {
    const result = await classifyNodeServerChanges([file], async () => {
      throw new Error('protected input must not require graph analysis')
    })
    expect(result.shouldRun).toBe(true)
    expect(result.graphUnavailable).toBeUndefined()
    expect(result.reason).toBe(`Build or CI input changed: ${file}`)
  }
)

it('retains a production force when an unrelated unit test changes in the same diff', async () => {
  const result = await classifyNodeServerChanges(
    ['src/main/persistence/example/unrelated.test.ts', 'src/main/persistence/example/worker.ts'],
    async () => {
      throw new Error('production input must not require graph analysis')
    }
  )
  expect(result.shouldRun).toBe(true)
  expect(result.graphUnavailable).toBeUndefined()
  expect(result.reason).toBe('Build or CI input changed: src/main/persistence/example/worker.ts')
})

it('defers uncertain paths without issuing a qualification verdict', async () => {
  const result = await classifyNodeServerChanges(
    ['src/renderer/src/example.ts'],
    async () => {
      throw new Error('graph must not run before installation')
    },
    { deferGraph: true }
  )
  expect(result.graphRequired).toBe(true)
  expect(result.shouldRun).toBeUndefined()
})

it.each([
  { files: [], deferred: true, expected: 'should_run=true' },
  { files: ['package.json'], deferred: true, expected: 'should_run=true' },
  {
    files: ['src/main/persistence/profile-state/profile-state-windows.ts'],
    deferred: true,
    fullQualification: false,
    qualification: false,
    runners: ['ubuntu-22.04', 'windows-2022', 'windows-11-arm'],
    expected: 'should_run=true'
  },
  {
    files: ['src/main/persistence/profile-state/profile-state-windows.ts'],
    deferred: true,
    expected: 'should_run=true'
  },
  {
    files: ['src/main/providers/provider-windows.ts'],
    deferred: true,
    fullQualification: false,
    expected: 'should_run=true'
  },
  { files: ['src/renderer/src/example.ts'], deferred: true, expected: 'graph_required=true' },
  { files: ['src/renderer/src/example.ts'], deferred: false, expected: 'should_run=true' }
])('fails closed or requests dependencies in an uninstalled checkout: %j', (scenario) => {
  const root = moduleTree(
    Object.fromEntries(
      ['node-server-change-scope', 'node-server-test-paths', 'node-server-qualification'].map(
        (name) => [
          `config/scripts/${name}.mjs`,
          readFileSync(new URL(`./${name}.mjs`, import.meta.url), 'utf8')
        ]
      )
    )
  )
  const changes = join(root, 'changes')
  const stepOutput = join(root, 'step-output')
  writeFileSync(changes, scenario.files.map((file) => `${file}\0`).join(''))
  const result = runProcessSync({
    program: process.execPath,
    args: [
      realpathSync(join(root, 'config/scripts/node-server-change-scope.mjs')),
      changes,
      ...(scenario.fullQualification === false ? [] : ['--full-qualification']),
      ...(scenario.deferred ? ['--defer-graph'] : [])
    ],
    cwd: root,
    env: { ...process.env, GITHUB_OUTPUT: stepOutput },
    timeoutMs: 5_000
  })
  expect(result.code).toBe(0)
  const output = readFileSync(stepOutput, 'utf8')
  expect(output).toContain(scenario.expected)
  if (scenario.expected === 'graph_required=true') {
    expect(output).not.toContain('should_run=')
    expect(output).not.toContain('runners=')
  } else {
    expect(output).toContain(`qualification=${scenario.qualification !== false}`)
    expect(output).toContain(`runners=${JSON.stringify(scenario.runners ?? NODE_SERVER_RUNNERS)}`)
  }
})

describe('the actual Bun build and profile-test dependency graph', () => {
  let inputs
  beforeAll(async () => {
    inputs = await collectNodeServerInputs()
  }, 60_000)

  it('tracks the shared close probe without pulling in its mocked renderer adapter', () => {
    expect(inputs.has('src/shared/pty-running-work-probe.ts')).toBe(true)
    expect(inputs.has('src/shared/pty-running-work-probe.test.ts')).toBe(true)
    expect(inputs.has('src/renderer/src/components/terminal/pty-running-work-probe.ts')).toBe(false)
    expect(inputs.has('src/renderer/src/runtime/runtime-terminal-inspection.ts')).toBe(false)
    expect([...inputs].some((file) => file.startsWith('src/renderer/'))).toBe(false)
  })

  it.each([
    'config/scripts/ci-shard-timings.json',
    'config/scripts/mobile-web-app-terminal-render.test.mjs',
    'src/renderer/src/components/terminal/pty-running-work-probe.ts',
    'src/renderer/src/runtime/runtime-terminal-inspection.ts',
    'src/main/ssh/ssh-relay-upload-stage-commands.test.ts',
    'src/main/persistence/terminal-topology/terminal-topology-boundary-ratchet.test.ts',
    'src/main/menu/register-app-menu.ts'
  ])('skips unrelated work: %s', async (file) => {
    expect((await classifyNodeServerChanges([file], async () => inputs)).shouldRun).toBe(false)
  })

  it.each([
    ...Object.values(ORCAD_CHILD_ENTRY_POINTS),
    'src/shared/keybindings/definitions-core-1.ts',
    'src/shared/pty-running-work-probe.ts',
    'src/shared/pty-running-work-probe.test.ts',
    'src/main/runtime/orca-runtime.ts',
    'src/main/windows/windows-process-table.ts',
    'src/main/worker-thread-entry-path.ts',
    'config/scripts/zip-extractor-command.mjs',
    'config/scripts/windows-process-tree-gyp-rebuild.mjs',
    'config/scripts/relay-windows-process-tree-prepared-addon.mjs',
    'config/scripts/orcad-windows-prebuild-cache.mjs',
    'config/scripts/profile-state-worker-smoke.mjs',
    'config/scripts/vitest-host-ports-setup.ts',
    'tests/e2e/daemon-running-work-probe.unit.test.ts'
  ])('retains the full matrix for a real runtime, worker or test input: %s', async (file) => {
    expect(inputs.has(file)).toBe(true)
    expect((await classifyNodeServerChanges([file], async () => inputs)).shouldRun).toBe(true)
  })

  it('retains all selected tests and the selectors the Bun runner uses', () => {
    const tests = discoverNodeServerTests()
    expect(tests.length).toBeGreaterThan(80)
    expect(tests.every((file) => inputs.has(file))).toBe(true)
    expect(
      nodeServerTestPaths().every((selector) => tests.some((file) => file.includes(selector)))
    ).toBe(true)
  })
})

it('keeps every platform job and runs them when detection is skipped or fails', () => {
  const workflow = parse(
    readFileSync(new URL('../../.github/workflows/node-server-tests.yml', import.meta.url), 'utf8')
  )
  expect(workflow.on).toHaveProperty('workflow_dispatch')
  expect(workflow.jobs.changes.if).toBe(
    "github.event_name == 'push' || (github.event_name == 'pull_request' && github.event.pull_request.draft != true)"
  )
  expect(workflow.jobs.changes.steps[0].with['fetch-depth']).toBe(2)
  expect(workflow.jobs.changes.steps[0].with['persist-credentials']).toBe(false)
  const detect = workflow.jobs.changes.steps.find((step) => step.id === 'scope')
  expect(detect.run).toContain('git diff --name-only --no-renames -z HEAD^1 HEAD')
  expect(detect.env.PUSH_BASE).toBe('${{ github.event.before }}')
  expect(detect.run).toContain('git fetch --no-tags --depth=1 origin "$PUSH_BASE"')
  expect(detect.run).toContain('git diff --name-only --no-renames -z "$PUSH_BASE" HEAD')
  expect(detect.run).toContain('node-server-changes" --defer-graph --full-qualification')
  expect(workflow.on.pull_request.types).toContain('ready_for_review')
  expect(workflow.on.schedule).toHaveLength(1)
  // A pull request may qualify one platform, so the merged commit must re-qualify all six.
  expect(workflow.on.push.branches).toEqual(['main'])
  expect(workflow.on.push.paths).toEqual(workflow.on.pull_request.paths)
  // The push and schedule paths must not rest on a null property comparison.
  expect(workflow.jobs.persistence.if).toContain(
    "github.event_name != 'pull_request' || github.event.pull_request.draft != true"
  )
  expect(workflow.jobs.persistence.strategy.matrix.os).toContain('needs.changes.outputs.runners')
  for (const jobName of ['linux_glibc_floor', 'linux_musl']) {
    const job = workflow.jobs[jobName]
    expect(job.needs).toEqual(['changes', 'persistence'])
    expect(job.if).toContain("needs.persistence.result == 'success'")
    expect(job.if).toContain("needs.changes.outputs.qualification != 'false'")
    expect(job.if).toContain("needs.changes.outputs.should_run != 'false'")
    expect(job.strategy.matrix.os).toEqual(['ubuntu-22.04', 'ubuntu-24.04-arm'])
  }
})

it('builds server glibc slots on glibc 2.28 and the compat slot on glibc 2.17 (design D6)', () => {
  const workflow = parse(
    readFileSync(new URL('../../.github/workflows/node-server-tests.yml', import.meta.url), 'utf8')
  )
  const floor = workflow.jobs.linux_glibc_floor
  expect(floor.container).toBe('${{ matrix.image }}')
  expect(floor.strategy.matrix.include).toEqual([
    {
      os: 'ubuntu-22.04',
      image: expect.stringMatching(/^quay\.io\/pypa\/manylinux_2_28_x86_64@sha256:[0-9a-f]{64}$/)
    },
    {
      os: 'ubuntu-24.04-arm',
      image: expect.stringMatching(/^quay\.io\/pypa\/manylinux_2_28_aarch64@sha256:[0-9a-f]{64}$/)
    }
  ])
  expect(floor.env).toMatchObject({ CC: 'gcc', CXX: 'g++' })

  const compat = workflow.jobs.linux_glibc217_compat
  expect(compat.needs).toEqual(['changes', 'persistence'])
  expect(compat.if).toBe(floor.if)
  expect(compat['runs-on']).toBe('ubuntu-22.04')
  const run = compat.steps.map((step) => step.run ?? '').join('\n')
  expect(run).toMatch(/quay\.io\/pypa\/manylinux2014_x86_64@sha256:[0-9a-f]{64} /)
  expect(run).toContain('--slot=linux-x64-glibc217 --print-runtime')
  expect(run).toContain('build-orcad-prebuilds.mjs --slot=linux-x64-glibc217\n')
  expect(run).toContain('--require-slots linux-x64-glibc217')
  expect(run).toContain(
    'env -u LD_LIBRARY_PATH node config/scripts/build-orcad-prebuilds.mjs --slot=linux-x64-glibc217 --smoke'
  )
})

it('runs the Bun and Node cross-runtime tests on Linux against pinned inputs', () => {
  const workflow = parse(
    readFileSync(new URL('../../.github/workflows/node-server-tests.yml', import.meta.url), 'utf8')
  )
  const steps = workflow.jobs.persistence.steps
  const setupBun = steps.find((step) => String(step.uses).startsWith('oven-sh/setup-bun@'))
  expect(setupBun.uses).toMatch(/^oven-sh\/setup-bun@[0-9a-f]{40}$/)
  // Mirrors LAST_BUN_ORCAD_VERSION in src/main/orcad/orcad-node-slot-fixture.ts.
  expect(setupBun.with['bun-version']).toBe('1.4.2')
  const build = steps.find((step) => String(step.run).includes('build-orcad-bun.mjs'))
  expect(build.env.BUN_ORCAD_COMMIT).toMatch(/^[0-9a-f]{40}$/)
  expect(setupBun.if).toBe("runner.os == 'Linux'")
  expect(build.id).toBe('bun-orcad')
  expect(build.background).toBe(true)
  expect(build.if).toBeUndefined()
  expect(build['continue-on-error']).toBeUndefined()
  expect(build.run).toMatch(/^if \[ "\$RUNNER_OS" != Linux \]; then exit 0; fi\n/)
  expect(build.run).toContain(
    'pnpm --dir "$RUNNER_TEMP/bun-orcad-source" install --frozen-lockfile --ignore-scripts'
  )
  expect(build.run).not.toContain('"$GITHUB_WORKSPACE/node_modules"')
  expect(build.run).toContain('echo "slot=$RUNNER_TEMP/bun-orcad" >> "$GITHUB_OUTPUT"')
  expect(build.run).toContain('echo "executable=$(command -v bun)" >> "$GITHUB_OUTPUT"')
  expect(build.run).not.toContain('GITHUB_ENV')
  const join = steps.findIndex((step) => step.wait === build.id)
  expect(join).toBeGreaterThan(steps.indexOf(build))
  expect(steps[join].if).toBeUndefined()
  expect(steps[join]['continue-on-error']).toBeUndefined()
  const consumer = steps.find((step) => step.run?.startsWith('pnpm test:node-server --artifact '))
  expect(steps.indexOf(consumer)).toBeGreaterThan(join)
  expect(consumer.run).toBe(
    "pnpm test:node-server --artifact ${{ runner.os == 'Linux' && '--cross-runtime' || '' }}"
  )
  expect(consumer.if).toBeUndefined()
  expect(consumer.env).toEqual({
    ORCA_BUN_ORCAD_SLOT: '${{ steps.bun-orcad.outputs.slot }}',
    BUN_EXECUTABLE: '${{ steps.bun-orcad.outputs.executable }}'
  })
  const alpine = workflow.jobs.linux_musl.steps.find((step) =>
    String(step.run).includes('docker run')
  )
  expect(alpine.run).toMatch(
    new RegExp(
      `node:${NODE_RUNTIME_PIN.version.replaceAll('.', '\\.')}-alpine@sha256:[0-9a-f]{64} `
    )
  )
})
