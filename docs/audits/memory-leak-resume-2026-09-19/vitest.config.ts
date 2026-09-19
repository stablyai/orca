import { defineConfig } from 'vitest/config'
import baseConfig from '../../../config/vitest.config'

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: ['docs/audits/memory-leak-resume-2026-09-19/native-chat-preview-retention.test.tsx']
  }
})
