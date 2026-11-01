import { defineConfig } from 'vitest/config'
import baseConfig from './vitest.config'

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    // Project-level includes otherwise override this benchmark-only selection.
    projects: undefined,
    include: ['config/scripts/agent-status-hot-path-benchmark.ts'],
    fileParallelism: false,
    retry: 0
  }
})
