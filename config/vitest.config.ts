import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const windowsTestWorkerOptions = process.platform === 'win32' ? { maxWorkers: 4 } : {}

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
    execArgv: ['--no-experimental-webstorage'],
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
    // Why: the full suite runs heavy TS transforms plus real git/http fixtures;
    // the Vitest 5s defaults are too tight for the slowest integration cases.
    hookTimeout: 60_000,
    testTimeout: 30_000,
    // Why: Windows process and shell startup are slower under full-suite load;
    // macOS/Linux keep Vitest's default worker parallelism.
    ...windowsTestWorkerOptions
  }
})
