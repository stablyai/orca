import { defineConfig } from 'vitest/config'
import type { OxcOptions } from 'vite'
import { fileURLToPath } from 'node:url'

// Vite 8's public OxcOptions type omits `tsconfig`, but the transform path
// accepts it; without this, Vitest's oxc transform fails to locate tsconfig.
const oxcNoTsconfigLookup = { tsconfig: false } as unknown as OxcOptions

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  oxc: oxcNoTsconfigLookup,
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts']
  }
})
