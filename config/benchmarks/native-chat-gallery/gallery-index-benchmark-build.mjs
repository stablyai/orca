import { build } from 'vite'
import { resolve } from 'node:path'
import { markdownParserAliases } from '../../build-plugins/markdown-parser-exports.ts'

const root = import.meta.dirname
const repository = resolve(root, '../../..')
const output =
  process.env.ORCA_GALLERY_BENCH_OUTPUT ?? resolve(repository, '.artifacts/gallery-index-benchmark')
await build({
  configFile: false,
  tsconfig: resolve(repository, 'config/tsconfig.web.json'),
  root,
  base: './',
  resolve: { alias: { ...markdownParserAliases, '@': resolve(repository, 'src/renderer/src') } },
  worker: { format: 'es' },
  build: { outDir: output, emptyOutDir: true, target: 'es2020', minify: 'oxc', sourcemap: true }
})
