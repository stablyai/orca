import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const vitestOxcConfig = { tsconfig: false } as never

export default defineConfig({
  root: import.meta.dirname,
  // Tests are excluded from the app tsconfig; disable that config for OXC so test modules still transform.
  oxc: vitestOxcConfig,
  resolve: {
    // A faithful Node stand-in for the native module, rather than a mock in every test that reaches it.
    alias: [
      {
        find: /^\.\/mobile-agent-icon-assets$/,
        replacement: fileURLToPath(
          new URL('./src/test-support/mobile-agent-icon-assets-node.ts', import.meta.url)
        )
      },
      {
        find: 'expo-crypto',
        replacement: fileURLToPath(
          new URL('./src/test-support/expo-crypto-node.ts', import.meta.url)
        )
      },
      {
        find: /^.*\/orca-mobile-web-shell\/src\/spare-document$/,
        replacement: fileURLToPath(
          new URL('./src/test-support/spare-document-node.ts', import.meta.url)
        )
      },
      {
        find: /^.*\/orca-mobile-web-shell\/src\/generation-store-directory$/,
        replacement: fileURLToPath(
          new URL('./src/test-support/generation-store-directory-node.ts', import.meta.url)
        )
      },
      {
        find: 'expo-haptics',
        replacement: fileURLToPath(
          new URL('./src/test-support/expo-haptics-node.ts', import.meta.url)
        )
      },
      // Phone/host contract tests import original sources at runtime; only their Node type check reads declarations.
      { find: '@orca/test-mobile', replacement: fileURLToPath(new URL('./src', import.meta.url)) },
      { find: '@orca/test-host', replacement: fileURLToPath(new URL('../src', import.meta.url)) }
    ]
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
