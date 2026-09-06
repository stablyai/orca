import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import baseConfig from './vitest.config'

const contracts = [
  'src/main/sqlite/sync-database.test.ts',
  'src/main/runtime/orchestration/db/row-column-lists.test.ts',
  'src/relay/fs-path-metadata-symlink-concurrency.test.ts',
  'src/renderer/src/components/editor/rich-markdown-list-tokenizers.test.ts',
  'src/renderer/src/components/editor/rich-markdown-lowlight-cache.test.ts',
  'src/renderer/src/components/terminal-pane/agent-completion-coordinator-queued-inspection-disposal.test.ts',
  'src/renderer/src/lib/pane-manager/pane-terminal-output-scheduler-queue-retention.test.ts',
  'config/scripts/app-store-performance-plugin.test.mjs',
  'config/scripts/quadratic-buffer-concat-plugin.test.mjs',
  'config/scripts/sort-comparator-performance-plugin.test.mjs'
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
    include: contracts,
    fileParallelism: false,
    retry: 0
  }
})
