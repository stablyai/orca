import original from './vitest.config.ts'

// This parent owns explicit companions; ordinary unit collection must not launch them.
export default {
  ...original,
  test: {
    ...original.test,
    projects: undefined,
    pool: 'forks',
    maxWorkers: 1,
    include: ['src/main/runtime/push/push-owner-live.test-fixture.ts'],
    exclude: [],
    testTimeout: 180_000
  }
}
