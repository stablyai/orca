import original from '../mobile/vitest.config.ts'

export default {
  ...original,
  test: {
    ...original.test,
    pool: 'forks',
    maxWorkers: 1,
    include: ['src/notifications/push-owner-live.test-fixture.ts'],
    testTimeout: 150_000
  }
}
