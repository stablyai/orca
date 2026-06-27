import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

const tsconfigRaw = JSON.stringify({
  compilerOptions: {
    jsx: 'react-jsx',
    module: 'esnext',
    moduleResolution: 'bundler',
    strict: true,
    target: 'es2022'
  }
})

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  esbuild: {
    tsconfigRaw
  },
  optimizeDeps: {
    esbuildOptions: {
      tsconfigRaw
    }
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts']
  }
})
