// Bundles src/panel.tsx to dist/panel.js. `orca` is provided by Orca at runtime, so it stays external.
// Run from an Orca checkout (`node examples/plugins/hello-components/build.mjs`) or with esbuild installed.
import path from 'node:path'
import { build } from 'esbuild'

const root = import.meta.dirname
await build({
  entryPoints: [path.join(root, 'src', 'panel.tsx')],
  outfile: path.join(root, 'dist', 'panel.js'),
  bundle: true,
  format: 'esm',
  target: 'es2022',
  jsx: 'automatic',
  jsxImportSource: 'orca',
  external: ['orca', 'orca/*'],
  legalComments: 'none',
  banner: { js: '// Built from src/panel.tsx by build.mjs.' }
})
