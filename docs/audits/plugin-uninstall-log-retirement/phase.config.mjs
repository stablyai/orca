import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
import { resolve, relative, sep, dirname } from 'node:path'
import base from '../../../config/vitest.config.ts'
const require = createRequire(import.meta.url)
const { loadSources, sha256 } = require('./sources.cjs')
const loaded = loadSources()
const evaluated = {}
process.on('exit', () => {
  if (process.env.ORCA_PLUGIN_LOG_EVALUATED) {
    writeFileSync(process.env.ORCA_PLUGIN_LOG_EVALUATED, `${JSON.stringify(evaluated, null, 2)}\n`)
  }
})
export default {
  ...base,
  plugins: [
    {
      name: 'plugin-uninstall-source-fence',
      enforce: 'pre',
      resolveId(source, importer) {
        if (!source.startsWith('.') || !importer) {
          return null
        }
        const target = resolve(dirname(importer), source)
        for (const candidate of [
          target,
          `${target}.ts`,
          `${target}.tsx`,
          `${target}.json`,
          resolve(target, 'index.ts')
        ]) {
          if (loaded.sources.has(candidate)) {
            return candidate
          }
        }
        return null
      },
      load(id) {
        const filename = resolve(id.split('?')[0])
        const local = relative(loaded.root, filename).split(sep).join('/')
        if (local.startsWith('src/') || local.startsWith('config/') || local.startsWith('tests/')) {
          const source = loaded.sources.get(filename)
          if (source === undefined) {
            throw new Error(`Unfenced repository module: ${local}`)
          }
          evaluated[local] = sha256(source)
          return source
        }
        return null
      }
    }
  ],
  test: {
    ...base.test,
    maxWorkers: 1,
    include: ['docs/audits/plugin-uninstall-log-retirement/scenario.test.mjs']
  }
}
