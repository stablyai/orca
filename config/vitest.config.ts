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
    setupFiles: [resolve('config/vitest-git-background-jobs-env.ts')],
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
    // Why: Windows process and shell startup are slower under full-suite load;
    // macOS/Linux keep Vitest's default worker parallelism.
    ...windowsTestWorkerOptions
  }
})
