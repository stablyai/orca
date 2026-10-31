import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  root: fileURLToPath(new URL('../cloud/apps/push', import.meta.url)),
  test: {
    pool: 'forks',
    maxWorkers: 1,
    include: ['src/push-owner-live.test-fixture.ts'],
    testTimeout: 150_000
  }
})
