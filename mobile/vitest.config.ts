import { defineConfig } from 'vitest/config'

const vitestOxcConfig = { tsconfig: false } as never

export default defineConfig({
  root: import.meta.dirname,
  // Why: the app tsconfig intentionally excludes tests; Vite 8's OXC transform
  // otherwise fails before Vitest can run the test modules.
  oxc: vitestOxcConfig,
  test: {
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    onConsoleLog: (log) => !log.includes('react-test-renderer is deprecated'),
    // .tsx too: component tests exist (react-test-renderer + mocked react-native) and were
    // silently never collected, so render-level regressions shipped untested.
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx']
  }
})
