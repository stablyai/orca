import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { classifyNodeServerChanges, collectNodeServerInputs } from './node-server-change-scope.mjs'
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
  {
    files: ['src/main/persistence/profile-state/profile-state-recovery-crash-boundaries.test.ts'],
    deferred: true,
    fullQualification: false,
    pullRequest: true,
    nativeGraph: true,
    expected: 'should_run=true'
  },
  { files: ['src/renderer/src/example.ts'], deferred: true, expected: 'graph_required=true' },
  { files: ['src/renderer/src/example.ts'], deferred: false, expected: 'should_run=true' }
])('fails closed or requests dependencies in an uninstalled checkout: %j', (scenario) => {
  const root = moduleTree(
    Object.fromEntries(
      [
        'node-server-change-scope',
        'node-server-test-paths',
        'node-server-qualification',
        'node-server-native-compat-scope'
      ].map((name) => [
        `config/scripts/node-server/qualification/${name}.mjs`,
        readFileSync(new URL(`./${name}.mjs`, import.meta.url), 'utf8')
      ])
    )
  )
  const changes = join(root, 'changes')
  const stepOutput = join(root, 'step-output')
  const statuses = join(root, 'native-diff')
  writeFileSync(changes, scenario.files.map((file) => `${file}\0`).join(''))
  writeFileSync(
    statuses,
    scenario.files
      .map((file) => `:100644 100644 ${'1'.repeat(40)} ${'2'.repeat(40)} M\0${file}\0`)
      .join('')
  )
  const result = runProcessSync({
    program: process.execPath,
    args: [
      realpathSync(
        join(root, 'config/scripts/node-server/qualification/node-server-change-scope.mjs')
      ),
      changes,
      ...(scenario.fullQualification === false ? [] : ['--full-qualification']),
      ...(scenario.deferred ? ['--defer-graph'] : []),
      ...(scenario.pullRequest ? ['--pull-request', '--diff-paths', statuses] : [])
    ],
    cwd: root,
    env: { ...process.env, GITHUB_OUTPUT: stepOutput },
    timeoutMs: 5_000
  })
  expect(result.code).toBe(0)
  const output = readFileSync(stepOutput, 'utf8')
  expect(output).toContain(scenario.expected)
  if (scenario.nativeGraph) {
    expect(output).toContain('graph_required=true')
    expect(output).not.toContain('native_compatibility=')
  }
  if (scenario.expected === 'graph_required=true') {
    expect(output).not.toContain('should_run=')
    expect(output).not.toContain('runners=')
  } else {
    expect(output).toContain(`qualification=${scenario.qualification !== false}`)
    expect(output).toContain(`runners=${JSON.stringify(scenario.runners ?? NODE_SERVER_RUNNERS)}`)
  }
})
