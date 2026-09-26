import { build } from 'esbuild'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..', '..')

export const ORCAD_EXTERNAL_MODULES = [
  'electron',
  'node-pty',
  '@parcel/watcher',
  'fsevents',
  'bun:ffi',
  'bun:sqlite'
]

// Native binaries are staged separately from every JavaScript entry.
export const externalNativeAddons = {
  name: 'external-native-addons',
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /\.node$/ }, (args) => ({ path: args.path, external: true }))
  }
}

// The UMD build's relative dynamic requires cannot be bundled.
const jsoncParserEsm = {
  name: 'jsonc-parser-esm',
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^jsonc-parser$/ }, () => ({
      path: join(root, 'node_modules', 'jsonc-parser', 'lib', 'esm', 'main.js')
    }))
  }
}

export function buildOrcadEntry(outfile) {
  return build({
    entryPoints: [join(root, 'src/main/orcad/main.ts')],
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    outfile,
    external: ORCAD_EXTERNAL_MODULES,
    plugins: [jsoncParserEsm, externalNativeAddons],
    metafile: true,
    minify: true,
    sourcemap: false,
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'error'
  })
}
