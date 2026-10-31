import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const vitestOxcConfig = { tsconfig: false } as never

export default defineConfig({
  root: import.meta.dirname,
  // Tests are excluded from the app tsconfig; disable that config for OXC so test modules still transform.
  oxc: vitestOxcConfig,
  resolve: {
    // A faithful Node stand-in for the native module, rather than a mock in every test that reaches it.
    alias: {
      'expo-crypto': fileURLToPath(
        new URL('./src/test-support/expo-crypto-node.ts', import.meta.url)
      )
    }
  },
  test: {
    // Web renderer tests must resolve the SVG/icon libraries through the same host aliases.
    server: {
      deps: {
        inline: ['lucide-react-native', 'react-native-svg'],
        external: [/\/config\/scripts\/build-mobile-web-app-bundle\.mjs$/]
      }
    },
    pool: 'threads',
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    onConsoleLog: (log) => !log.includes('react-test-renderer is deprecated'),
    // Collect component and script tests too so render regressions and CI tooling are covered.
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'scripts/**/*.test.ts']
  }
})
