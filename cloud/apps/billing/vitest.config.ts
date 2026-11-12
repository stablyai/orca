import { defineConfig } from 'vitest/config'

export default defineConfig({
  // A string tsconfig skips the lookup, which otherwise climbs to the desktop app's tsconfig.
  oxc: { tsconfig: false },
  test: {
    include: ['test/**/*.test.ts'],
    // The whole suite runs once per ENTITLEMENTS_MODE (env.ts): the legacy computation, shadow
    // (legacy served, the grant resolver must agree everywhere: test/shadow-guard.ts) and on.
    // Each project extends this config, so it inherits `include`.
    projects: [
      { extends: true, test: { name: 'legacy' } },
      { extends: true, test: { name: 'shadow', env: { BILLING_TEST_ENTITLEMENTS_MODE: 'shadow' }, setupFiles: ['test/shadow-guard.ts'] } },
      { extends: true, test: { name: 'on', env: { BILLING_TEST_ENTITLEMENTS_MODE: 'on' } } }
    ]
  }
})
