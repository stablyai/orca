import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const outDir = path.join(repoRoot, 'out/desktop-host')
mkdirSync(outDir, { recursive: true })

await build({
  entryPoints: [path.join(repoRoot, 'src/desktop-host/desktop-host-entry.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: path.join(outDir, 'index.js'),
  packages: 'external',
  sourcemap: true
})

console.log('[desktop-host] bundled out/desktop-host/index.js')
