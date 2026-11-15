import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import baseConfig from './vitest.config.ts'
import { nodeRuntimePool } from './scripts/test-runtime/node-worker/vitest-node-runtime-pool.ts'

const contracts = [
  'src/main/runtime/session-tabs/session-tabs-phone-layout-moves.test.ts',
  'src/renderer/src/components/tab-bar/use-new-tab-agent-menu-host-preferences.test.tsx',
  'src/shared/native-chat/tools/native-chat-tool-pairing.performance.test.ts',
  'src/main/codex-usage/codex-rollout-file-lifetime.test.ts',
  'src/main/codex-usage/scanner-incremental-append.test.ts',
  'src/main/usage/source-input/jsonl/jsonl-file-reader.test.ts',
  'config/scripts/static-analysis/oxlint-contracts/app-store-performance-plugin.test.mjs',
  'config/scripts/static-analysis/oxlint-contracts/quadratic-buffer-concat-plugin.test.mjs'
]
for (const contract of contracts) {
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
    include: contracts,
    benchmark: { include: [] },
    fileParallelism: false,
    retry: 0
  }
})
