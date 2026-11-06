import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // A string tsconfig skips the lookup, which otherwise climbs to the desktop app's tsconfig.
  oxc: { tsconfig: false },
  resolve: {
    alias: {
      '@orca-cloud/relay-contract': fileURLToPath(new URL('../../packages/relay-contract/src/index.ts', import.meta.url)),
      // Tests only: lets them import the relay's database module for the live schema.
      '@orca-cloud/postgres-schema': fileURLToPath(new URL('../../packages/postgres-schema/src/index.ts', import.meta.url))
    }
  },
  test: { include: ['test/**/*.test.ts'] }
})
