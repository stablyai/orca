import { defineConfig } from 'vitest/config'
import baseConfig from './vitest.config.ts'
import { nodeRuntimePool } from './scripts/test-runtime/node-worker/vitest-node-runtime-pool.ts'

// Perf contracts: the only tests allowed to count work (docs/agents-md-refs/test-antipatterns.md#perf-contracts).
const contractGlobs = [
  'src/**/*.performance.test.{ts,tsx,mjs}',
  'config/scripts/**/*.performance.test.{ts,tsx,mjs}',
  'tests/tools/**/*.performance.test.{ts,tsx,mjs}'
]

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    // Project-level includes otherwise override this contract-only selection.
    projects: undefined,
    ...(process.versions.bun ? { pool: 'node-runtime', poolRunner: nodeRuntimePool } : {}),
    include: contractGlobs,
    // No contract exists today; keep the job green until the first one lands.
    passWithNoTests: true,
    benchmark: { include: [] },
    retry: 0
  }
})
