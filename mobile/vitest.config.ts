import { defineConfig, type ViteUserConfig } from 'vitest/config'

const tsconfig = {
  compilerOptions: {
    jsx: 'react-jsx',
    module: 'esnext',
    moduleResolution: 'bundler',
    strict: true,
    target: 'es2022'
  }
}

const tsconfigRaw = JSON.stringify(tsconfig)
type OxcTransformOptionsWithTsconfig = NonNullable<ViteUserConfig['oxc']> & {
  tsconfig: typeof tsconfig
}
const oxcTransformOptions = { tsconfig } as OxcTransformOptionsWithTsconfig

export default defineConfig({
  // Why: Vitest/Vite 8's OXC transform does not find this package tsconfig
  // when running through the generated test server, so pass it explicitly.
  oxc: oxcTransformOptions,
  root: import.meta.dirname,
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
