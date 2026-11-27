import { defineConfig } from 'vitest/config'

export default defineConfig({
  // A string tsconfig skips the lookup, which otherwise climbs to the desktop app's tsconfig.
  oxc: { tsconfig: false },
  // Sources imported from sibling packages resolve `zod` to this package's copy, so no root install is needed.
  resolve: { dedupe: ['zod'] },
  test: { include: ['test/**/*.test.ts'] }
})
