import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { classifyNodeServerChanges, collectNodeServerInputs } from './node-server-change-scope.mjs'
import { runProcessSync } from '@orca/process-host'
import { NODE_SERVER_RUNNERS, nodeServerQualification } from './node-server-qualification.mjs'

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
        `config/scripts/${name}.mjs`,
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
      realpathSync(join(root, 'config/scripts/node-server-change-scope.mjs')),
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

const registry = 'config/scripts/vitest-node-runtime-files.mjs'
const unrelatedSshUnit = 'src/main/ssh/pinned-runtime-materializer-context.test.ts'

function qualificationTree(extra = {}) {
  return moduleTree({
    'entry.ts': `import './${registry}'; throw Error('never execute')`,
    [registry]: 'export const NODE_RUNTIME_INCLUDE = []',
    [unrelatedSshUnit]: 'throw Error("never execute unrelated test")',
    ...extra
  })
}

it('keeps a Node harness smoke without widening it for an unrelated modified SSH unit', async () => {
  const root = qualificationTree()
  writeFileSync(join(root, registry), 'export const NODE_RUNTIME_INCLUDE = ["new.unit.test.ts"]')
  const changed = [registry, unrelatedSshUnit]
  const scope = await classifyNodeServerChanges(
    changed,
    () => collectNodeServerInputs({ root, entryPoints: ['entry.ts'] }),
    { modifiedFiles: changed }
  )
  expect(scope.shouldRun).toBe(true)
  expect(nodeServerQualification(changed, scope)).toEqual({
    qualification: false,
    runners: ['ubuntu-22.04']
  })
  expect(nodeServerQualification(changed, scope, { fullQualification: true })).toEqual({
    qualification: true,
    runners: NODE_SERVER_RUNNERS
  })
})

it.each([
  ['src/main/daemon/daemon-authenticated-client-activity.test.ts', NODE_SERVER_RUNNERS, true],
  [
    'src/main/daemon/daemon-endpoint-windows.test.ts',
    ['ubuntu-22.04', 'windows-2022', 'windows-11-arm'],
    false
  ]
])('retains daemon platform coverage: %s', async (daemon, runners, qualification) => {
  const root = qualificationTree({ [daemon]: 'throw Error("unselected")' })
  const diff = [registry, daemon, unrelatedSshUnit]
  const g = await collectNodeServerInputs({ root, entryPoints: ['entry.ts'] })
  expect(g.has(registry)).toBe(true)
  expect(g.has(daemon)).toBe(false)
  const s = await classifyNodeServerChanges(diff, async () => g, { modifiedFiles: diff })
  expect(s.shouldRun).toBe(true)
  expect(nodeServerQualification(diff, s)).toEqual({ qualification, runners })
})

it('keeps every host when the modified SSH production module is an actual consumer', async () => {
  const ssh = 'src/main/ssh/pinned-runtime-materializer.ts'
  const root = qualificationTree({
    'entry.ts': `import './${registry}'; import './${ssh}'; throw Error('never execute')`,
    [ssh]: 'export const materializer = 1'
  })
  const changed = [registry, ssh, unrelatedSshUnit]
  const scope = await classifyNodeServerChanges(
    changed,
    () => collectNodeServerInputs({ root, entryPoints: ['entry.ts'] }),
    { modifiedFiles: changed }
  )
  expect(scope.shouldRun).toBe(true)
  expect(scope).toMatchObject({ graphResolved: true, matchedFiles: [registry, ssh] })
  expect(nodeServerQualification(changed, scope)).toEqual({
    qualification: true,
    runners: NODE_SERVER_RUNNERS
  })
})

it.each(['added', 'deleted', 'renamed', 'unknown', 'duplicate', 'foreign'])(
  'retains complete-path qualification when modification evidence is %s',
  async (status) => {
    const root = qualificationTree()
    const changed = [registry, unrelatedSshUnit]
    let modifiedFiles = [registry]
    if (status === 'deleted' || status === 'renamed') {
      rmSync(join(root, unrelatedSshUnit))
    }
    if (status === 'renamed') {
      const renamed = 'src/main/ssh/renamed-context.test.ts'
      writeFileSync(join(root, renamed), 'throw Error("never execute renamed test")')
      changed.push(renamed)
    }
    if (status === 'duplicate') {
      modifiedFiles = [registry, registry]
    }
    if (status === 'foreign') {
      modifiedFiles = [registry, 'src/main/ssh/foreign.test.ts']
    }
    const scope = await classifyNodeServerChanges(
      changed,
      () => collectNodeServerInputs({ root, entryPoints: ['entry.ts'] }),
      status === 'unknown' ? {} : { modifiedFiles }
    )
    expect(scope.shouldRun).toBe(true)
    expect(nodeServerQualification(changed, scope)).toEqual({
      qualification: true,
      runners: NODE_SERVER_RUNNERS
    })
  }
)

it('retains protected server tests and broken imports despite complete modification evidence', async () => {
  const protectedTest = 'src/main/sqlite/example.test.ts'
  const root = qualificationTree({ [protectedTest]: 'export const value = 1' })
  const changed = [registry, protectedTest, unrelatedSshUnit]
  const collect = () => collectNodeServerInputs({ root, entryPoints: ['entry.ts'] })
  const protectedScope = await classifyNodeServerChanges(changed, collect, {
    modifiedFiles: changed
  })
  expect(nodeServerQualification(changed, protectedScope)).toEqual({
    qualification: true,
    runners: NODE_SERVER_RUNNERS
  })
  writeFileSync(join(root, 'entry.ts'), `import './${registry}'; import './missing'`)
  const brokenChanged = [registry, unrelatedSshUnit]
  const brokenScope = await classifyNodeServerChanges(brokenChanged, collect, {
    modifiedFiles: brokenChanged
  })
  expect(brokenScope.graphUnavailable).toBe(true)
  expect(nodeServerQualification(brokenChanged, brokenScope)).toEqual({
    qualification: true,
    runners: NODE_SERVER_RUNNERS
  })
})
