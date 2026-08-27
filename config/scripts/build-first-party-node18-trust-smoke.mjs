import { build } from 'esbuild'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

const projectDir = resolve(import.meta.dirname, '../..')
const outputDirectory = resolve(projectDir, 'out', 'test')

await mkdir(outputDirectory, { recursive: true })
await build({
  entryPoints: [resolve(import.meta.dirname, 'first-party-node18-trust-smoke-entry.ts')],
  outfile: resolve(outputDirectory, 'first-party-node18-trust-smoke.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  packages: 'external',
  sourcemap: false
})
