import { createRequire } from 'node:module'
import { dirname, relative, resolve, sep } from 'node:path'
import base from '../../../config/vitest.config.ts'
const require = createRequire(import.meta.url)
const { loadSources } = require(resolve('docs/audits/closed-editor-model-lifetime/sources.cjs'))

const loaded = loadSources()
export default {
  ...base,
  plugins: [
    {
      name: 'closed-model-source-fence',
      enforce: 'pre',
      resolveId(source, importer) {
        const target = source.startsWith('@/')
          ? resolve(loaded.root, 'src/renderer/src', source.slice(2))
          : source.startsWith('.') && importer
            ? resolve(dirname(importer), source)
            : source.startsWith(loaded.root)
              ? source
              : null
        if (!target) {
          return null
        }
        for (const extension of ['', '.ts', '.tsx', '.json']) {
          const candidate = `${target}${extension}`
          if (loaded.sources.has(candidate)) {
            return candidate
          }
        }
        return null
      },
      load(id) {
        const name = resolve(id.split('?')[0])
        const local = relative(loaded.root, name)
        if (local.startsWith(`src${sep}`) || local.startsWith(`config${sep}`)) {
          if (!loaded.sources.has(name)) {
            throw new Error(`Unfenced repository source: ${name}`)
          }
          return loaded.sources.get(name)
        }
        return null
      }
    }
  ],
  test: {
    ...base.test,
    environment: 'happy-dom',
    maxWorkers: 1,
    include: ['docs/audits/closed-editor-model-lifetime/lifecycle.test.mjs']
  }
}
