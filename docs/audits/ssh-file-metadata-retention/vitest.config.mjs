import { resolve, sep } from 'node:path'
import { createRequire } from 'node:module'
import base from '../../../config/vitest.config.ts'
const { loadSources, observePending } = createRequire(import.meta.url)('./sources.cjs')
const loaded = loadSources()
export default {
  ...base,
  test: {
    ...base.test,
    setupFiles: [],
    include: ['docs/audits/ssh-file-metadata-retention/scenario.test.mjs'],
    maxWorkers: 1
  },
  plugins: [
    {
      name: 'ssh-file-metadata-source-graph',
      enforce: 'pre',
      transform(_source, id) {
        const absolute = resolve(id.split('?')[0])
        const source = loaded.sources.get(absolute)
        if (source !== undefined) {
          return { code: observePending(source), map: null }
        }
        if (absolute.startsWith(resolve(loaded.root, 'src') + sep) && absolute.endsWith('.ts')) {
          throw new Error(`Unreviewed source import: ${absolute}`)
        }
        return null
      }
    }
  ]
}
