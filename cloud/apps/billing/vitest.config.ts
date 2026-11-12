import { defineConfig } from 'vitest/config'

const include = ['test/**/*.test.ts']

export default defineConfig({
  // A string tsconfig skips the lookup, which otherwise climbs to the desktop app's tsconfig.
  oxc: { tsconfig: false },
  test: {
    // The whole suite runs once per ENTITLEMENTS_MODE (env.ts): the legacy computation, shadow
    // (legacy served, the grant resolver must agree everywhere: test/shadow-guard.ts) and on.
    projects: [
      { extends: true, test: { name: 'legacy', include } },
      { extends: true, test: { name: 'shadow', include, env: { BILLING_TEST_ENTITLEMENTS_MODE: 'shadow' }, setupFiles: ['test/shadow-guard.ts'] } },
      { extends: true, test: { name: 'on', include, env: { BILLING_TEST_ENTITLEMENTS_MODE: 'on' } } }
    ]
  }
})
