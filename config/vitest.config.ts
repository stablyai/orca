import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const testWorkerOptions = { maxWorkers: 4 }

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
    // Why: Node 26's undefined Web Storage globals prevent Vitest from installing happy-dom's.
    // Why --expose-gc: retention tests need a deterministic collection point to measure what a queue really holds.
    execArgv: ['--no-experimental-webstorage', '--expose-gc'],
    // Why: happy-dom drops MutationObserver callbacks on GC; keep them alive like a browser does.
    setupFiles: [resolve('config/scripts/happy-dom-mutation-observer-retention.ts')],
    include: [
      'src/**/*.test.ts',
      'src/**/*.test.tsx',
      'config/scripts/**/*.test.ts',
      'config/scripts/**/*.test.mjs',
      'tests/tools/**/*.test.mjs',
      'tests/e2e/**/*.unit.test.ts'
    ],
    setupFiles: ['config/vitest-dom-storage.ts'],
    // Why: the full suite runs heavy TS transforms plus real git/http fixtures;
    // the Vitest 5s defaults are too tight for the slowest integration cases.
    hookTimeout: 60_000,
    testTimeout: 30_000,
    // Why: process/socket integration tests are sensitive to full-suite worker
    // pressure across platforms, especially when native relay setup is active.
    ...testWorkerOptions
  }
})
