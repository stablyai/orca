import { build } from 'esbuild'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../..')
await build({
  entryPoints: {
    'cli-bin': resolve(root, 'src/cli/cli-bin.ts'),
    'cli-bun-launcher': resolve(root, 'src/cli/runtime/cli-bun-launcher.ts')
  },
  outdir: resolve(root, 'out/cli'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18'
})
