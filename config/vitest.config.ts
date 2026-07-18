import { availableParallelism } from 'node:os'
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import { resolveUnitTestWorkerCount } from './scripts/interactive-test-worker-budget.mjs'

export default defineConfig({
  define: {
    ORCA_FEATURE_WALL_ENABLED: 'true'
  },
  resolve: {
    alias: {
      '@renderer': resolve('src/renderer/src'),
      '@': resolve('src/renderer/src')
    }
  },
  test: {
    environment: 'node',
    include: [
      'src/**/*.test.ts',
      'src/**/*.test.tsx',
      'config/scripts/**/*.test.mjs',
      'tests/e2e/**/*.unit.test.ts'
    ],
    // Why: the full suite runs heavy TS transforms plus real git/http fixtures;
    // the Vitest 5s defaults are too tight for the slowest integration cases.
    hookTimeout: 60_000,
    testTimeout: 30_000,
    // Why: full-suite transforms can otherwise consume every available CPU and
    // starve the running Orca session plus short-lived CLI recovery commands.
    maxWorkers: resolveUnitTestWorkerCount(availableParallelism())
  }
})
