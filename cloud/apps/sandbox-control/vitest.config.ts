import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // A string tsconfig skips the lookup, which otherwise climbs to the desktop app's tsconfig.
  oxc: { tsconfig: false },
  // workerd-only module (BuildTicker's base class); see the stub.
  resolve: { alias: { 'cloudflare:workers': fileURLToPath(new URL('./test/cloudflare-workers-stub.ts', import.meta.url)) } },
  test: { include: ['test/**/*.test.ts', 'image/**/*.test.ts'] }
})
