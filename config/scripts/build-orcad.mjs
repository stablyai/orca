#!/usr/bin/env node
/**
 * Bundle `orcad` — the Orca runtime served from plain Node, no Electron.
 *
 * Variant B (see docs/design/node-only-runtime-backend.html): the browser-pane and
 * speech clusters are excluded. That is not a size optimisation — those modules are
 * the only ones that statically import `node:sqlite`, so dropping them is what keeps
 * the host Node floor at 18 instead of 22.5+.
 */
import { build } from 'esbuild'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'

const ROOT = join(import.meta.dirname, '..', '..')
const OUT_DIR = join(ROOT, 'out', 'orcad')
const ENTRY = join(ROOT, 'src/main/orcad/main.ts')

// Native addons must exist on the host; they cannot be bundled.
// `electron` is external so a residual import fails loudly at require() time rather
// than silently bundling the npm package's installer shim, which is what happened the
// first time and made the bundle look clean while it was not.
// Why only these: measured, not guessed. `node-pty` is a hard `require.resolve` — orcad
// exits at startup without it. `@parcel/watcher` is a guarded dynamic import, so the
// server boots without it but every watch install fails. `fsevents` is macOS-only and
// optional upstream. better-sqlite3 / keytar / cpu-features were externalized here
// defensively and appear nowhere in the graph; listing them implied a shipping burden
// that does not exist.
const EXTERNAL = ['electron', 'node-pty', '@parcel/watcher', 'fsevents']

/** Why: the UMD build's relative dynamic requires do not bundle. Same fix build-relay.mjs uses. */
const jsoncParserEsm = {
  name: 'jsonc-parser-esm',
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^jsonc-parser$/ }, () => ({
      path: join(ROOT, 'node_modules', 'jsonc-parser', 'lib', 'esm', 'main.js')
    }))
  }
}

/** Why: optional native deps reference prebuilt .node files that may not exist here. */
const externalNativeAddons = {
  name: 'external-native-addons',
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /\.node$/ }, (args) => ({ path: args.path, external: true }))
  }
}

rmSync(OUT_DIR, { recursive: true, force: true })
mkdirSync(OUT_DIR, { recursive: true })

const result = await build({
  entryPoints: [ENTRY],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  outfile: join(OUT_DIR, 'orcad.js'),
  external: EXTERNAL,
  plugins: [jsoncParserEsm, externalNativeAddons],
  metafile: true,
  minify: true,
  sourcemap: false,
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'error'
})

const output = Object.values(result.metafile.outputs).find((o) => o.entryPoint)
// Why check `original` and not just `path`: when electron is bundleable, esbuild
// rewrites `path` to the resolved file under node_modules and the naive check passes
// while the package is very much in the bundle.
const electronImporters = new Set()
for (const [file, info] of Object.entries(result.metafile.inputs)) {
  for (const imported of info.imports ?? []) {
    const specifier = imported.original ?? imported.path
    if (specifier === 'electron' || specifier.startsWith('electron/')) {
      electronImporters.add(file)
    }
  }
}

if (electronImporters.size > 0) {
  console.error(
    `[build-orcad] ${electronImporters.size} module(s) in the bundle import electron:
${[...electronImporters].map((f) => `  - ${f}`).join('\n')}`
  )
  // Why this can exceed the ratchet baseline: the ratchet measures the graph reachable
  // from orca-runtime + runtime-rpc, but this entry also imports ipc/pty directly to
  // install the PTY controller. Once orcad ships, it should become a ratchet entry
  // point so the two numbers cannot drift.
  process.exitCode = 1
} else {
  console.log(
    `[build-orcad] ok — ${(output.bytes / 1024 / 1024).toFixed(2)} MB, ${Object.keys(output.inputs).length} modules, zero electron imports.`
  )
}
