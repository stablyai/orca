import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import baseConfig from './vitest.config'
import { nodeRuntimePool } from './scripts/test-runtime/node-worker/vitest-node-runtime-pool'

const contracts = [
  'src/main/runtime/session-tabs/session-tabs-phone-layout-moves.test.ts',
  'src/renderer/src/components/terminal-pane/pty-connection/startup/saved-resume-cancellation.test.ts',
  'src/main/native-chat/agent-session-wire/host/testing/structured-agent-session-terminal-writer-acquire.test.ts',
  'src/shared/agent-launch/permissions/tui-agent-permission-choice.test.ts',
  'src/main/runtime/rpc/methods/projects/repo.test.ts',
  'src/renderer/src/components/tab-bar/use-new-tab-agent-menu-host-preferences.test.tsx',
  'src/main/sqlite/sync-database.test.ts',
  'src/main/runtime/orchestration/db/row-column-lists.test.ts',
  'src/shared/native-chat/tools/native-chat-tool-pairing.performance.test.ts',
  'src/main/codex-usage/codex-rollout-file-lifetime.test.ts',
  'src/main/codex-usage/scanner-incremental-append.test.ts',
  'src/main/usage/jsonl-file-reader.test.ts',
  'src/main/usage/jsonl-file-snapshot.test.ts',
  'src/renderer/src/lib/pane-manager/pane-terminal-output-scheduler-queue-retention.test.ts',
  'config/scripts/static-analysis/oxlint-contracts/app-store-performance-plugin.test.mjs',
  'config/scripts/static-analysis/oxlint-contracts/quadratic-buffer-concat-plugin.test.mjs',
  'src/main/claude-usage/scanner-incremental-append.test.ts',
  'src/main/claude-usage/store-checkpoint-persistence.test.ts'
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
