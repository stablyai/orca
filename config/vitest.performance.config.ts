import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import baseConfig from './vitest.config.ts'
import { nodeRuntimePool } from './scripts/test-runtime/node-worker/vitest-node-runtime-pool.ts'

// Perf contracts: the only tests allowed to count work (docs/agents-md-refs/test-antipatterns.md#perf-contracts).
const contractGlobs = [
  'src/**/*.performance.test.{ts,tsx}',
  'config/scripts/**/*.performance.test.mjs'
]
// Older contracts named before the suffix existed.
const namedContracts = [
  'src/renderer/src/components/agent/launch-menu/use-new-tab-agent-menu-host-preferences.test.tsx',
  'src/main/codex-usage/codex-rollout-file-lifetime.test.ts',
  'src/main/codex-usage/scanner-incremental-append.test.ts',
  'src/main/usage/source-input/jsonl/jsonl-file-reader.test.ts',
  'config/scripts/static-analysis/oxlint-contracts/app-store-performance-plugin.test.mjs',
  'config/scripts/static-analysis/oxlint-contracts/quadratic-buffer-concat-plugin.test.mjs'
]
// Wall-clock budgets aren't contracts: this selection must run in seconds and never flake on a busy runner.
const notContracts = ['src/main/bots/bot-chat-search-host.performance.test.ts']
for (const contract of namedContracts) {
  if (!existsSync(resolve(contract))) {
    throw new Error(`Missing performance contract: ${contract}`)
  }
}

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    // Project-level includes otherwise override this contract-only selection.
    projects: undefined,
    ...(process.versions.bun ? { pool: 'node-runtime', poolRunner: nodeRuntimePool } : {}),
    include: [...contractGlobs, ...namedContracts],
    exclude: [...(baseConfig.test?.exclude ?? []), ...notContracts],
    benchmark: { include: [] },
    fileParallelism: false,
    retry: 0
  }
})
