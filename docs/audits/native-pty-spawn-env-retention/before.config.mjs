import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { defineConfig, mergeConfig } from 'vitest/config'
import baseConfig from '../../../config/vitest.config.ts'

const { loadSources } = createRequire(import.meta.url)(
  resolve('docs/audits/native-pty-spawn-env-retention/sources.cjs')
)
const { before } = loadSources()
export default mergeConfig(
  baseConfig,
  defineConfig({
    plugins: [
      {
        name: 'native-pty-env-before-fix',
        enforce: 'pre',
        transform(_code, id) {
          const source = before.get(resolve(id.split('?')[0]))
          return source === undefined ? undefined : { code: source, map: null }
        }
      }
    ]
  })
)
