import { resolve } from 'node:path'
import { defaultExclude, defineConfig } from 'vitest/config'
import { UNIT_INCLUDE, UNIT_EXCLUDE } from './scripts/ci-unit-files.mjs'
import TimingSequencer from './scripts/ci-unit-sequencer.mjs'
import { NODE_RUNTIME_INCLUDE } from './scripts/vitest-node-runtime-files.mjs'
import { nodeRuntimePool } from './scripts/vitest-node-runtime-pool'

const balancedShards = process.env.ORCA_BALANCE_UNIT_SHARDS === '1'
const transforms = {
  define: { ORCA_FEATURE_WALL_ENABLED: 'true' },
  resolve: {
    alias: {
      '@renderer': resolve('src/renderer/src'),
      '@': resolve('src/renderer/src'),
      'fs/promises': 'node:fs/promises',
      fs: 'node:fs',
      os: 'node:os'
    }
  }
}
const testOptions = {
  environment: 'node',
  env: { ORCA_VITEST_RUNTIME: 'node' },
  server: { deps: { inline: ['zod'] } },
  // Node's storage globals and V8 retention checks require the existing child flags.
  execArgv: ['--no-experimental-webstorage', '--expose-gc'],
  setupFiles: [
    resolve('config/scripts/vitest-real-agent-home-write-guard.ts'),
    resolve('config/scripts/vitest-bun-node-builtins.ts'),
    resolve('config/scripts/happy-dom-offscreen-canvas.ts'),
    resolve('config/scripts/happy-dom-mutation-observer-retention.ts'),
    resolve('config/scripts/vitest-host-ports-setup.ts'),
    resolve('config/scripts/vitest-caller-identity-env-setup.ts')
  ],
  include: UNIT_INCLUDE,
  exclude: balancedShards ? UNIT_EXCLUDE : defaultExclude,
  // testTimeout matches hookTimeout: under full-suite parallelism even ordinary
  // renderer tests breach 30s (CPU saturation delays waitFor loops), flaking them.
  hookTimeout: 60_000,
  testTimeout: 60_000
}
const projects = [
  {
    ...transforms,
    test: {
      ...testOptions,
      name: 'bun',
      env: { ORCA_VITEST_RUNTIME: 'bun' },
      pool: 'forks',
      exclude: [...testOptions.exclude, ...NODE_RUNTIME_INCLUDE]
    }
  },
  {
    ...transforms,
    test: {
      ...testOptions,
      name: 'node-runtime',
      env: { ORCA_VITEST_RUNTIME: 'node-runtime' },
      include: NODE_RUNTIME_INCLUDE,
      pool: 'node-runtime',
      poolRunner: nodeRuntimePool
    }
  }
]

export default defineConfig({
  ...transforms,
  test: {
    ...testOptions,
    ...(balancedShards
      ? {
          sequence: { sequencer: TimingSequencer },
          reporters: ['default', resolve('config/scripts/ci-unit-timing-reporter.mjs')]
        }
      : {}),
    ...(process.versions.bun ? { projects } : {}),
    ...(process.platform === 'win32' ? { maxWorkers: 4 } : {})
  }
})
