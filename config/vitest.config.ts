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
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'config/scripts/**/*.test.mjs']
  }
})
