import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { defineConfig, mergeConfig } from 'vitest/config'
import baseConfig from '../../../config/vitest.config.ts'

const { loadSources } = createRequire(import.meta.url)('./sources.cjs')
const { before } = loadSources()
const sourcePath = resolve('src/main/daemon/daemon-session-owner-resolution.ts')

export default mergeConfig(
  baseConfig,
  defineConfig({
    plugins: [
      {
        name: 'shared-owner-incarnation-before-fix',
        enforce: 'pre',
        transform(_code, id) {
          return resolve(id.split('?')[0]) === sourcePath ? { code: before, map: null } : undefined
        }
      }
    ]
  })
)
