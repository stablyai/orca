import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

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
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'config/scripts/**/*.test.mjs'],
    // Why: the full suite runs heavy TS transforms plus real git/http fixtures;
    // the Vitest 5s defaults are flaky on Windows under parallel load.
    hookTimeout: 60_000,
    maxWorkers: 8,
    testTimeout: 30_000
  }
})
