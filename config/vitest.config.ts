import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  define: {
    ORCA_FEATURE_WALL_ENABLED: 'true'
  },
  plugins: [
    {
      name: 'strip-mjs-hashbang-for-tests',
      enforce: 'pre',
      transform(code, id) {
        const filePath = id.split('?')[0]
        if (!filePath.endsWith('.mjs') || !code.startsWith('#!')) {
          return null
        }
        return {
          code: code.replace(/^#!.*(?:\r?\n|$)/, ''),
          map: null
        }
      }
    }
  ],
  resolve: {
    alias: {
      '@renderer': resolve('src/renderer/src'),
      '@': resolve('src/renderer/src')
    }
  },
  test: {
    environment: 'node',
    // Why: Windows can orphan a Vitest fork under full-suite load; keep enough
    // parallelism for coverage while avoiding worker-pool exits.
    ...(process.platform === 'win32' ? { maxWorkers: 8 } : {}),
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'config/scripts/**/*.test.mjs']
  }
})
