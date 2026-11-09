import { defineConfig } from 'vitest/config'

export default defineConfig({
  // A string tsconfig skips the lookup, which otherwise climbs to the desktop app's tsconfig.
  oxc: { tsconfig: false },
  test: { include: ['test/**/*.test.ts'] }
})
