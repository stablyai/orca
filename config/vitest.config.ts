import { globSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { normalizePath, transformWithOxc, type Plugin } from 'vite'
import { configDefaults, defaultExclude, defineConfig } from 'vitest/config'
import {
  UNIT_INCLUDE,
  UNIT_EXCLUDE,
  UNIT_SETUP_FILES
} from './scripts/ci/unit-selection/dependency-graph/ci-unit-files.mjs'
import TimingSequencer from './scripts/ci/sharding/ci-unit-sequencer.mjs'
import { filesSafeToShareWorker } from './scripts/test-runtime/execution-policy/vitest-shared-worker-files.mjs'
import RuntimeSequencer from './scripts/test-runtime/execution-policy/vitest-runtime-sequencer.mjs'
import { getNodeRuntimeInclude } from './scripts/test-runtime/sqlite-admission/vitest-node-runtime-files.mjs'
import { nodeRuntimePool } from './scripts/test-runtime/node-worker/vitest-node-runtime-pool'
import { readRunFilters } from './scripts/test-runtime/execution-policy/vitest-run-filters.mjs'
import { createWorkspaceSourceResolver } from './scripts/workspace/source-exports/workspace-source-exports.mjs'
import { moduleCacheResolutionKey } from './scripts/test-runtime/module-cache/vitest-module-cache-resolution-key'
import { vitestReactCompiler } from './build-plugins/vitest-react-compiler'

const nodeRuntimeInclude = process.versions.bun
  ? getNodeRuntimeInclude({ filters: readRunFilters() })
  : []
const balancedShards = process.env.ORCA_BALANCE_UNIT_SHARDS === '1'
const moduleCachePath = process.env.ORCA_UNIT_MODULE_CACHE_PATH
const phoneContractPattern = /\/mobile\/src\/.*\.(?:ts|tsx)(?:\?.*)?$/
const transforms = {
  // Auto-discovery climbs past the repo for files no in-repo tsconfig owns, into an enclosing checkout.
  tsconfig: resolve(import.meta.dirname, 'tsconfig.vitest-transform.json'),
  oxc: { exclude: [/\.js$/, phoneContractPattern] },
  plugins: [
    {
      // These plain TS consumers need no Expo app configuration in root-only installs.
      name: 'phone-contract-oxc',
      enforce: 'pre',
      async transform(source, id) {
        const filename = normalizePath(id.split('?')[0])
        if (!phoneContractPattern.test(filename)) {
          return null
        }
        const result = await transformWithOxc(source, filename, { tsconfig: false })
        for (const warning of result.warnings) {
          this.warn(warning)
        }
        return { code: result.code, map: result.map }
      }
    } satisfies Plugin,
    ...(moduleCachePath ? [moduleCacheResolutionKey()] : []),
    ...vitestReactCompiler(),
    {
      // Unit tests have no asset server; retain real catalog parsing through fetch(data:).
      name: 'locale-catalog-test-assets',
      enforce: 'pre' as const,
      load(id: string) {
        if (/\/i18n\/locales\/[A-Za-z-]+\.json\?url$/.test(id)) {
          const catalog = readFileSync(id.slice(0, -4)).toString('base64')
          return `export default ${JSON.stringify(`data:application/json;base64,${catalog}`)}`
        }
        return null
      }
    }
  ],
  define: {
    ORCA_FEATURE_WALL_ENABLED: 'true',
    // Why: tests only interpolate it; they must not depend on the checkout's HEAD.
    ORCA_BUILD_COMMIT: JSON.stringify('0'.repeat(40)),
    // A dark switch set to 'main' in the env (`ORCA_LAYOUT_OWNER=main pnpm vitest`) is on in tests.
    ...createRequire(import.meta.url)('./dark-build-switches.cjs').turnedOnDarkBuildDefines()
  },
  resolve: {
    alias: [
      ...(process.env.ORCA_UNIT_ZOD_BUNDLE
        ? [{ find: /^zod$/, replacement: process.env.ORCA_UNIT_ZOD_BUNDLE }]
        : []),
      ...createWorkspaceSourceResolver().aliases,
      { find: '@renderer', replacement: resolve('src/renderer/src') },
      { find: '@', replacement: resolve('src/renderer/src') },
      { find: 'fs/promises', replacement: 'node:fs/promises' },
      { find: 'fs', replacement: 'node:fs' },
      { find: 'os', replacement: 'node:os' }
    ]
  }
}
const testOptions = {
  environment: 'node',
  clearMocks: false,
  ...(balancedShards ? { silent: 'passed-only' as const } : {}),
  // Keyed by ci-unit-module-cache.mjs in CI and vitest-local-module-cache.mjs locally.
  fsModuleCache: Boolean(moduleCachePath),
  ...(moduleCachePath ? { fsModuleCachePath: moduleCachePath } : {}),
  env: { ORCA_VITEST_RUNTIME: 'node' },
  server: { deps: { inline: ['zod'] } },
  // Node's storage globals and V8 retention checks require the existing child flags.
  execArgv: ['--no-experimental-webstorage', '--expose-gc'],
  setupFiles: UNIT_SETUP_FILES.map((file) => resolve(file)),
  include: UNIT_INCLUDE,
  exclude: balancedShards ? UNIT_EXCLUDE : defaultExclude,
  hookTimeout: 60_000,
  testTimeout: 30_000
}
const nodeProject = {
  extends: false,
  ...transforms,
  test: {
    ...testOptions,
    name: process.versions.bun ? 'node-runtime' : 'node',
    env: { ORCA_VITEST_RUNTIME: process.versions.bun ? 'node-runtime' : 'node' },
    include: process.versions.bun ? nodeRuntimeInclude : UNIT_INCLUDE,
    sequence: { groupOrder: 1 },
    ...(process.versions.bun
      ? { pool: 'node-runtime', poolRunner: nodeRuntimePool }
      : { pool: 'forks' })
  }
}
const bunProject = {
  extends: false,
  ...transforms,
  test: {
    ...testOptions,
    name: 'bun',
    env: { ORCA_VITEST_RUNTIME: 'bun' },
    pool: 'forks',
    exclude: [...testOptions.exclude, ...nodeRuntimeInclude],
    sequence: { groupOrder: 1 }
  }
}
// Files whose state the per-file reset can undo share one worker's module cache instead of
// re-importing thousands of modules each. ORCA_VITEST_ISOLATE_EVERY_FILE=1 turns it off.
// Windows workers that keep native addons (process tree, ConPTY) across files die of heap
// corruption (0xC0000374); production code loads them lazily, so the file scan can't see them.
const runtimeProject = process.versions.bun ? bunProject : nodeProject
const nodeRuntimeFiles = new Set(nodeRuntimeInclude.map((file) => file.replaceAll('\\', '/')))
const sharedWorkerFiles =
  process.env.ORCA_VITEST_ISOLATE_EVERY_FILE === '1' || process.platform === 'win32'
    ? []
    : filesSafeToShareWorker(
        process.cwd(),
        globSync(UNIT_INCLUDE)
          .map((file) => file.replaceAll('\\', '/'))
          .filter((file) => !nodeRuntimeFiles.has(file)),
        [
          { find: '@renderer', replacement: resolve('src/renderer/src') },
          { find: '@', replacement: resolve('src/renderer/src') }
        ]
      )
const sharedProjects =
  sharedWorkerFiles.length > 0
    ? [
        {
          ...runtimeProject,
          test: {
            ...runtimeProject.test,
            name: `${runtimeProject.test.name}-shared`,
            include: sharedWorkerFiles,
            isolate: false,
            runner: resolve(
              'config/scripts/test-runtime/execution-policy/vitest-shared-worker-setup-runner.mjs'
            ),
            setupFiles: [
              ...runtimeProject.test.setupFiles,
              resolve('config/scripts/test-runtime/environment/vitest-shared-worker-file-reset.mjs')
            ]
          }
        }
      ]
    : []
runtimeProject.test.exclude = [
  ...(runtimeProject.test.exclude ?? testOptions.exclude),
  ...sharedWorkerFiles
]
const projects = [...(process.versions.bun ? [bunProject] : []), nodeProject, ...sharedProjects]

export default defineConfig({
  ...transforms,
  test: {
    ...testOptions,
    forceRerunTriggers: [
      ...configDefaults.forceRerunTriggers,
      '**/pnpm-lock.yaml',
      '**/pnpm-workspace.yaml',
      '**/config/**',
      '**/patches/**',
      '**/src/packages/**'
    ],
    sequence: { sequencer: balancedShards ? TimingSequencer : RuntimeSequencer },
    ...(balancedShards
      ? {
          reporters: ['default', resolve('config/scripts/ci/sharding/ci-unit-timing-reporter.mjs')]
        }
      : {}),
    projects,
    // A finished file's background log can lose the race with worker teardown; only that log line is lost.
    onUnhandledError: (error) =>
      !(error.name === 'EnvironmentTeardownError' && error.message.includes('"onUserConsoleLog"')),
    ...(process.platform === 'win32' ? { maxWorkers: 4 } : {})
  }
})
