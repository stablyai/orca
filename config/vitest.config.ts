import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { normalizePath, transformWithOxc, type Plugin } from 'vite'
import { configDefaults, defaultExclude, defineConfig } from 'vitest/config'
import { UNIT_INCLUDE, UNIT_EXCLUDE, UNIT_SETUP_FILES } from './scripts/ci-unit-files.mjs'
import TimingSequencer from './scripts/ci-unit-sequencer.mjs'
import RuntimeSequencer from './scripts/vitest-runtime-sequencer.mjs'
import { getNodeRuntimeInclude } from './scripts/vitest-node-runtime-files.mjs'
import { nodeRuntimePool } from './scripts/vitest-node-runtime-pool'
import { readRunFilters } from './scripts/vitest-run-filters.mjs'
import { createWorkspaceSourceResolver } from './scripts/workspace-source-exports.mjs'
import { moduleCacheResolutionKey } from './scripts/vitest-module-cache-resolution-key'

const nodeRuntimeInclude = process.versions.bun
  ? getNodeRuntimeInclude({ filters: readRunFilters() })
  : []
const balancedShards = process.env.ORCA_BALANCE_UNIT_SHARDS === '1'
const moduleCachePath = process.env.ORCA_UNIT_MODULE_CACHE_PATH
const measurementFile = 'src/main/foreign-sqlite-readers/foreign-sqlite-reader-event-loop.test.ts'
const paletteMeasurementFile =
  'src/renderer/src/lib/palette-match/palette-match-performance.test.ts'
const measurementFiles = [measurementFile, paletteMeasurementFile]
const phoneContractModules = [
  'mobile/src/session/native-chat/mobile-native-chat-stream-frame.ts',
  'mobile/src/session/mobile-native-chat-render-data.ts'
].map((file) => normalizePath(resolve(file)))
const phoneContractPattern = new RegExp(
  `^(?:${phoneContractModules.map((file) => file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?:\\?.*)?$`
)
const transforms = {
  oxc: { exclude: [/\.js$/, phoneContractPattern] },
  plugins: [
    {
      // These plain TS consumers need no Expo app configuration in root-only installs.
      name: 'phone-contract-oxc',
      enforce: 'pre',
      async transform(source, id) {
        const filename = normalizePath(id.split('?')[0])
        if (!phoneContractModules.includes(filename)) {
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
  // Persistent transforms are CI-keyed (ci-unit-module-cache.mjs); local runs stay cold.
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
    exclude: [...testOptions.exclude, ...measurementFiles],
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
    exclude: [...testOptions.exclude, ...nodeRuntimeInclude, ...measurementFiles],
    sequence: { groupOrder: 1 }
  }
}
const paletteRuntimeProject = process.versions.bun ? bunProject : nodeProject
const projects = [
  ...(process.versions.bun ? [bunProject] : []),
  nodeProject,
  // Keep the event-loop measurement free of other suites without weakening its limits.
  {
    ...nodeProject,
    test: {
      ...nodeProject.test,
      name: 'node-measurement',
      include: [measurementFile],
      exclude: testOptions.exclude,
      maxWorkers: 1,
      sequence: { groupOrder: 2 }
    }
  },
  // Preserve the palette test's runtime and budgets while keeping other suites off its CPU.
  {
    ...paletteRuntimeProject,
    test: {
      ...paletteRuntimeProject.test,
      name: 'palette-measurement',
      include: [paletteMeasurementFile],
      exclude: testOptions.exclude,
      maxWorkers: 1,
      sequence: { groupOrder: 3 }
    }
  }
]

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
          reporters: ['default', resolve('config/scripts/ci-unit-timing-reporter.mjs')]
        }
      : {}),
    projects,
    ...(process.platform === 'win32' ? { maxWorkers: 4 } : {})
  }
})
