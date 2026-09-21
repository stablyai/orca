import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import base from '../../../config/vitest.config.ts'
const { loadSources, versions } = createRequire(import.meta.url)('./sources.cjs')
const loaded = loadSources({ variant: 'before' })
const target = resolve(loaded.root, versions.sourcePath)
export default {
  ...base,
  plugins: [
    {
      name: 'ssh-file-metadata-baseline',
      enforce: 'pre',
      transform(_source, id) {
        return resolve(id.split('?')[0]) === target
          ? { code: loaded.sources.get(target), map: null }
          : null
      }
    }
  ]
}
