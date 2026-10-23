import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import { compileAggregateExpression } from './pr-aggregate-gate-context.mjs'
import {
  classifyNativeCompatChanges,
  NATIVE_COMPAT_ENTRY_POINTS,
  readNativeCompatDiff
} from './node-server-native-compat-scope.mjs'
import { classifyNodeServerChanges, collectNodeServerInputs } from './node-server-change-scope.mjs'
import { NODE_SERVER_RUNNERS, nodeServerQualification } from './node-server-qualification.mjs'

const root = 'src/main/persistence/profile-state/profile-state-recovery-crash-boundaries.test.ts'
const support = 'src/main/native-chat/agent-session-journal/journal-host-database-test-support.ts'
const cleanup = JSON.parse(
  readFileSync(
    new URL('./node-server-native-compat-cleanup.test-fixture.json', import.meta.url),
    'utf8'
  )
)
const rawHeader = (status, beforeMode, afterMode) => {
  const before = (status === 'A' ? '0' : '1').repeat(40)
  const after = (status === 'D' ? '0' : '2').repeat(40)
  return `:${beforeMode} ${afterMode} ${before} ${after} ${status}`
}
const rawDiff = (entries) =>
  entries
    .map(([status, file]) => {
      const beforeMode = status === 'A' ? '000000' : '100644'
      const afterMode = status === 'D' ? '000000' : '100644'
      return `${rawHeader(status, beforeMode, afterMode)}\0${file}\0`
    })
    .join('')
const filesOf = (entries) => entries.map(([, file]) => file)
const nativeInputs = () => new Set(NATIVE_COMPAT_ENTRY_POINTS)
const optionsFor = (entries) => ({ pullRequest: true, rawDiff: rawDiff(entries) })

it('reconciles complete no-rename status evidence including additions and deletions', () => {
  const entries = [
    ['M', root],
    ['A', 'src/shared/new.spec.ts'],
    ['D', 'src/shared/old.test.ts']
  ]
  expect(readNativeCompatDiff(filesOf(entries), rawDiff(entries))).toEqual(
    entries.map(([status, file]) => ({ status, file }))
  )
})

it.each([
  [[], ''],
  [[root], undefined],
  [[root], rawDiff([['M', root]]).slice(0, -1)],
  [[root], `${rawDiff([['M', root]])}trailing\0`],
  [
    [root],
    rawDiff([
      ['M', root],
      ['M', root]
    ])
  ],
  [
    [root, root],
    rawDiff([
      ['M', root],
      ['M', root]
    ])
  ],
  [
    [root, 'src/shared/other.test.ts'],
    rawDiff([
      ['M', root],
      ['M', root]
    ])
  ],
  [[root], rawDiff([['M', 'src/shared/foreign.test.ts']])],
  [[root], rawDiff([['R100', root]])],
  [[root], rawDiff([['T', root]])],
  ...[
    'src/../outside.test.ts',
    'src/./outside.test.ts',
    'src//outside.test.ts',
    '/src/outside.test.ts',
    'src\\outside.test.ts',
    'src/C:/outside.test.ts'
  ].map((file) => [[file], rawDiff([['M', file]])])
])(
  'requires native qualification for incomplete or malformed diff evidence: %j',
  async (files, raw) => {
    const collect = vi.fn(nativeInputs)
    const result = await classifyNativeCompatChanges(files, collect, {
      pullRequest: true,
      rawDiff: raw
    })
    expect(result.nativeCompatibility).toBe(true)
    expect(collect).not.toHaveBeenCalled()
  }
)

it.each([
  ['120000', '120000', 'M'],
  ['000000', '120000', 'A'],
  ['120000', '000000', 'D'],
  ['160000', '160000', 'M'],
  ['100644', '120000', 'T'],
  ['100644', '100644', 'A'],
  ['000000', '000000', 'D'],
  ['100644', '000000', 'M']
])('rejects nonordinary or inconsistent modes: %s %s %s', async (beforeMode, afterMode, status) => {
  const raw = `${rawHeader(status, beforeMode, afterMode)}\0${root}\0`
  const collect = vi.fn(nativeInputs)
  const result = await classifyNativeCompatChanges([root], collect, {
    pullRequest: true,
    rawDiff: raw
  })
  expect(result.nativeCompatibility).toBe(true)
  expect(collect).not.toHaveBeenCalled()
})

it('checks the native closure before skipping a selected server test', async () => {
  const entries = [['M', root]]
  const collect = vi.fn(nativeInputs)
  const options = optionsFor(entries)
  const deferred = await classifyNativeCompatChanges([root], collect, {
    ...options,
    deferGraph: true
  })
  expect(deferred.graphRequired).toBe(true)
  expect(deferred.nativeCompatibility).toBeUndefined()
  expect(collect).not.toHaveBeenCalled()
  expect(await classifyNativeCompatChanges([root], collect, options)).toMatchObject({
    nativeCompatibility: false
  })
  expect(collect).toHaveBeenCalledWith({ entryPoints: NATIVE_COMPAT_ENTRY_POINTS })
})

it('retains native qualification when a recognized test is consumed by its builder or smoke', async () => {
  const result = await classifyNativeCompatChanges(
    [root],
    async () => new Set([...NATIVE_COMPAT_ENTRY_POINTS, root]),
    optionsFor([['M', root]])
  )
  expect(result.nativeCompatibility).toBe(true)
})

it.each(['missing-root', 'malformed-input', 'unavailable'])(
  'retains native qualification when closure evidence is %s',
  async (evidence) => {
    const collect = async () => {
      if (evidence === 'unavailable') {
        throw new Error('missing imported native input')
      }
      return evidence === 'missing-root'
        ? new Set()
        : new Set([...NATIVE_COMPAT_ENTRY_POINTS, '../bad'])
    }
    const result = await classifyNativeCompatChanges([root], collect, optionsFor([['M', root]]))
    expect(result.nativeCompatibility).toBe(true)
  }
)

it.each([
  'package.json',
  'pnpm-lock.yaml',
  '.npmrc',
  'src/shared/node-runtime-pin.ts',
  'src/shared/product-source.ts',
  'src/packages/process-host/src/run-process.test.ts',
  'native/example/fixture.test.ts',
  'config/patches/node-pty@1.1.0.patch',
  'config/scripts/build-orcad-prebuilds.mjs',
  'config/scripts/orcad-prebuild-smoke.test.mjs',
  'config/scripts/node-server-native-compat-scope.mjs',
  'config/scripts/node-server-native-compat-scope.test.mjs',
  'config/scripts/node-server-native-compat-cleanup.test-fixture.json',
  'config/scripts/node-server-change-scope.mjs',
  'config/scripts/verify-linux-glibc-floor.cjs',
  '.github/actions/prepare-native-runtime/action.yml',
  '.github/actions/prepare-headless-compiler/action.yml',
  '.github/workflows/node-server-tests.yml',
  'src/main/persistence/worker.test-fixture.ts',
  'src/main/native-chat/new-test-support.ts',
  'docs/ci.md'
])('keeps an unknown or protected input even when a test changes too: %s', async (file) => {
  const entries = [
    ['M', root],
    ['M', file]
  ]
  const collect = vi.fn(nativeInputs)
  const result = await classifyNativeCompatChanges(filesOf(entries), collect, optionsFor(entries))
  expect(result.nativeCompatibility).toBe(true)
  expect(collect).not.toHaveBeenCalled()
})

it.each(['A', 'D'])(
  'retains qualification for %s of a named test-support input',
  async (status) => {
    const entries = [[status, support]]
    const result = await classifyNativeCompatChanges([support], nativeInputs, optionsFor(entries))
    expect(result.nativeCompatibility).toBe(true)
  }
)

it.each([
  [
    ['D', 'src/shared/source.ts'],
    ['A', 'src/shared/source.test.ts']
  ],
  [
    ['D', 'src/shared/source.test.ts'],
    ['A', 'src/shared/source.ts']
  ]
])(
  'retains qualification for a rename crossing production and test paths: %j',
  async (...entries) => {
    const result = await classifyNativeCompatChanges(
      filesOf(entries),
      nativeInputs,
      optionsFor(entries)
    )
    expect(result.nativeCompatibility).toBe(true)
  }
)

it.each([{}, { pullRequest: false }, { pullRequest: true, fullQualification: true }])(
  'keeps native qualification without ordinary PR authorization: %j',
  async (options) => {
    const collect = vi.fn(nativeInputs)
    const result = await classifyNativeCompatChanges([root], collect, {
      rawDiff: rawDiff([['M', root]]),
      ...options
    })
    expect(result.nativeCompatibility).toBe(true)
    expect(collect).not.toHaveBeenCalled()
  }
)

it('qualifies a standalone change to the executable native routing policy', async () => {
  const file = 'config/scripts/node-server-native-compat-scope.mjs'
  const collect = vi.fn(nativeInputs)
  const scope = await classifyNodeServerChanges([file], collect, { modifiedFiles: [file] })
  expect(scope.shouldRun).toBe(true)
  expect(collect).not.toHaveBeenCalled()
  expect(nodeServerQualification([file], scope)).toEqual({
    qualification: true,
    runners: NODE_SERVER_RUNNERS
  })
  const native = await classifyNativeCompatChanges([file], collect, optionsFor([['M', file]]))
  expect(native.nativeCompatibility).toBe(true)
  expect(collect).not.toHaveBeenCalled()
})

it('recognizes the complete 119-path cleanup while retaining all runtime platform qualification', async () => {
  const entries = cleanup.paths
  expect(entries).toHaveLength(119)
  const files = filesOf(entries)
  const native = await classifyNativeCompatChanges(files, nativeInputs, {
    pullRequest: true,
    rawDiff: cleanup.rawDiff
  })
  expect(native.nativeCompatibility).toBe(false)
  const scope = await classifyNodeServerChanges(files, async () => {
    throw new Error('the selected profile-state test forces runtime qualification')
  })
  expect(scope.shouldRun).toBe(true)
  expect(scope.graphUnavailable).toBeUndefined()
  expect(nodeServerQualification(files, scope)).toEqual({
    qualification: true,
    runners: NODE_SERVER_RUNNERS
  })
})

it('checks the cleanup against the actual native build and smoke closure', async () => {
  const files = filesOf(cleanup.paths)
  const result = await classifyNativeCompatChanges(files, collectNodeServerInputs, {
    pullRequest: true,
    rawDiff: cleanup.rawDiff
  })
  expect(result.nativeCompatibility).toBe(false)
}, 60_000)

it('limits test-only native skip evidence to ordinary pull requests', () => {
  const workflow = parse(
    readFileSync(new URL('../../.github/workflows/node-server-tests.yml', import.meta.url), 'utf8')
  )
  const scope = workflow.jobs.changes.steps.find((step) => step.id === 'scope')
  const graph = workflow.jobs.changes.steps.find((step) => step.id === 'graph')
  expect(scope.run).toContain('git diff --raw --no-renames --no-abbrev -z HEAD^1 HEAD')
  for (const step of [scope, graph]) {
    const allowSkip = compileAggregateExpression(step.env.ALLOW_TEST_ONLY_NATIVE_SKIP, [
      'github',
      'inputs'
    ])
    for (const [event, template, ref, expected] of [
      ['pull_request', false, '', true],
      ['push', false, '', false],
      ['schedule', false, '', false],
      ['workflow_dispatch', false, '', false],
      ['workflow_call', false, '', false],
      ['pull_request', true, '', false],
      ['pull_request', false, 'refs/tags/v1', false]
    ]) {
      expect(
        allowSkip({
          github: { event_name: event },
          inputs: { build_template: template, ref }
        }).coerceString()
      ).toBe(String(expected))
    }
    expect(step.run).toContain('--pull-request --diff-paths "$RUNNER_TEMP/node-server-native-diff"')
  }
  for (const name of ['persistence', 'linux_glibc_floor', 'linux_musl']) {
    const eligible = compileAggregateExpression(workflow.jobs[name].if, [
      'needs',
      'github',
      'inputs'
    ])
    for (const native of ['true', 'false']) {
      expect(
        eligible({
          github: { event_name: 'pull_request', event: { pull_request: { draft: false } } },
          inputs: { build_template: false, ref: '' },
          needs: {
            changes: {
              outputs: { should_run: 'true', qualification: 'true', native_compatibility: native }
            },
            mobile_web_bundle: { result: 'success' }
          }
        }).coerceString()
      ).toBe('true')
    }
  }
  expect(workflow.on).toHaveProperty('workflow_dispatch')
  expect(workflow.on).toHaveProperty('workflow_call')
  expect(workflow.on.schedule).toHaveLength(1)
})

it('configures server glibc 2.28 slots and the glibc 2.17 compatibility lane', () => {
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
  expect(compat.needs).toBe('changes')
  expect(runInNewContext(compat['runs-on'].slice(3, -2), { inputs: { fast_runners: false } })).toBe(
    'ubuntu-22.04'
  )
  const run = compat.steps.map((step) => step.run ?? '').join('\n')
  expect(run).toMatch(/quay\.io\/pypa\/manylinux2014_x86_64@sha256:[0-9a-f]{64} /)
  expect(run).toContain('--slot=linux-x64-glibc217 --print-runtime')
  expect(run).toContain('build-orcad-prebuilds.mjs --slot=linux-x64-glibc217\n')
  expect(run).toContain('--require-slots linux-x64-glibc217')
  expect(run).toContain(
    'env -u LD_LIBRARY_PATH node config/scripts/build-orcad-prebuilds.mjs --slot=linux-x64-glibc217 --smoke'
  )
})

const nativeWorkflow = parse(
  readFileSync(new URL('../../.github/workflows/node-server-tests.yml', import.meta.url), 'utf8')
)
const nativeJob = compileAggregateExpression(nativeWorkflow.jobs.linux_glibc217_compat.if, [
  'needs',
  'github',
  'inputs'
])

it.each([
  { expected: false, native: 'false' },
  { expected: true, native: 'true' },
  { expected: true, native: '' },
  { expected: true },
  { expected: true, native: 'false', event: 'push' },
  { expected: true, native: 'false', event: 'schedule' },
  { expected: true, native: 'false', event: 'workflow_dispatch' },
  { expected: true, native: 'false', template: true },
  { expected: true, native: 'false', ref: 'other-commit' },
  { expected: true, native: 'true', persistence: 'failure' },
  { expected: true, native: 'true', persistence: 'cancelled' },
  { expected: true, native: 'true', persistence: 'skipped' },
  { expected: false, native: 'true', draft: true },
  { expected: false, native: 'true', qualification: 'false' },
  { expected: false, native: 'true', shouldRun: 'false' },
  { expected: false, native: 'true', cancelled: true }
])('evaluates the hosted native job guard with %j', (scenario) => {
  const context = {
    github: {
      event_name: scenario.event ?? 'pull_request',
      event: { pull_request: { draft: scenario.draft ?? false } }
    },
    inputs: { build_template: scenario.template ?? false, ref: scenario.ref ?? '' },
    needs: {
      persistence: { result: scenario.persistence ?? 'success' },
      changes: {
        outputs: {
          should_run: scenario.shouldRun ?? 'true',
          qualification: scenario.qualification ?? 'true',
          ...(scenario.native === undefined ? {} : { native_compatibility: scenario.native })
        }
      }
    }
  }
  expect(nativeJob(context, scenario.cancelled ?? false).coerceString()).toBe(
    String(scenario.expected)
  )
})

it.each(['M', 'A', 'D'])(
  'checks %s of the existing serializer test diagnostics against the native closure',
  async (status) => {
    const file = 'src/main/daemon/serialize-grid-variant-scope.ts'
    const result = await classifyNativeCompatChanges(
      [file],
      collectNodeServerInputs,
      optionsFor([[status, file]])
    )
    expect(result.nativeCompatibility).toBe(status !== 'M')
  },
  60_000
)
