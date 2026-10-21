import { createRequire } from 'node:module'
import path from 'node:path'
import { defineConfig, mergeConfig } from 'vitest/config'
import rootConfig from '../../../config/vitest.config.ts'

const require = createRequire(import.meta.url)
const { baselineSources } = require('./spawn-source.cjs')
const config = mergeConfig(
  rootConfig,
  defineConfig({
    plugins: [
      {
        name: 'completed-spawn-input-baseline',
        enforce: 'pre',
        load(id) {
          return baselineSources.get(path.normalize(id))
        }
      }
    ]
  })
)
config.test.include = ['src/main/daemon/terminal-host-spawn-input-retention.test.ts']
export default config
