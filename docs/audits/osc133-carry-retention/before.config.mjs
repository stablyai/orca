import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { defineConfig, mergeConfig } from 'vitest/config'
import baseConfig from '../../../config/vitest.config.ts'

const { loadSources, versions } = createRequire(import.meta.url)('./sources.cjs')
const { baseline } = loadSources()
const target = resolve(versions.sourcePath)

export default mergeConfig(
  baseConfig,
  defineConfig({
    plugins: [
      {
        name: 'osc133-before-owned-carry',
        enforce: 'pre',
        transform(_source, id) {
          return resolve(id.split('?')[0]) === target ? { code: baseline, map: null } : undefined
        }
      }
    ]
  })
)
