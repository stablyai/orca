import { resolve } from 'node:path'
import { mergeConfig } from 'vite'
import webConfig from '../vite.web.config'

// Dev-only component fixture explorer; never part of a production build input.
export default mergeConfig(webConfig, {
  cacheDir: resolve('.cache/vite/fixtures'),
  base: '/',
  server: {
    host: '127.0.0.1',
    warmup: {
      clientFiles: ['./src/component-fixtures/component-fixture-explorer.tsx']
    }
  },
  // Why: crawl fixtures up front so a lazily loaded fixture never triggers a dep
  // re-optimization, which would leave the warm page with two React copies.
  optimizeDeps: {
    entries: ['fixtures.html', 'src/**/*.fixture.tsx']
  },
  build: {
    outDir: resolve('.cache/fixtures/build'),
    rollupOptions: {
      input: resolve('src/renderer/fixtures.html')
    }
  }
})
