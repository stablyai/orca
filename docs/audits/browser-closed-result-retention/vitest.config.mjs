import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { defineConfig, mergeConfig } from 'vitest/config'
import base from '../../../config/vitest.config.ts'

const { loadSources } = createRequire(import.meta.url)('./sources.cjs')
const { before, after } = loadSources()
const sources = process.env.ORCA_BROWSER_CACHE_VARIANT === 'before' ? before : after
const config = mergeConfig(
  base,
  defineConfig({
    plugins: [
      {
        name: 'closed-browser-cache-source-overlay',
        enforce: 'pre',
        transform(_code, id) {
          const source = sources.get(resolve(id.split('?')[0]))
          return source === undefined ? undefined : { code: source, map: null }
        }
      }
    ]
  })
)
config.test.include = [
  'docs/audits/browser-closed-result-retention/scenario.test.mjs',
  'src/main/browser/browser-client-host-command-retention.test.ts',
  'src/main/browser/browser-client-host-command-dispatcher.test.ts'
]
config.test.maxWorkers = 1
export default config
