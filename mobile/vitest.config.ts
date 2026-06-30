import { defineConfig } from 'vitest/config'

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
  root: import.meta.dirname,
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
