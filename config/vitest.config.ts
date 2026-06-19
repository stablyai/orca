import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  define: {
    ORCA_FEATURE_WALL_ENABLED: 'true'
  },
  resolve: {
    alias: {
      '@renderer': resolve('src/renderer/src'),
      '@': resolve('src/renderer/src')
    }
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'config/scripts/**/*.test.mjs'],
    // Why: Windows process, socket, and git fixture setup regularly exceed
    // Vitest's 5s default under full-suite fork contention; keep other
    // platforms on the stricter default while making the Windows ship gate
    // deterministic.
    ...(process.platform === 'win32' ? { testTimeout: 15_000, hookTimeout: 30_000 } : {})
  }
})
