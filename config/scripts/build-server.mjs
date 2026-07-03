#!/usr/bin/env node
/**
 * Bundle the headless `orca-server` entry into a single CommonJS file with no
 * Electron dependency. `electron` is aliased to a throwing shim so any
 * un-abstracted Electron reach fails loudly; node-pty and @parcel/watcher stay
 * external (native addons resolved at runtime via the prebuilt matrix).
 *
 * Also serves as the Phase 0 graph probe: pass --report to emit a metafile and
 * print which modules still resolve the electron shim, before trusting the
 * bundle is truly Electron-free.
 */
import { build } from 'esbuild'
import { mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const __dirname = import.meta.dirname
const ROOT = join(__dirname, '..', '..')
const SERVER_ENTRY = join(ROOT, 'src', 'server', 'index.ts')
const SERVER_CLI_ENTRY = join(ROOT, 'src', 'server', 'cli.ts')
const ELECTRON_SHIM = join(ROOT, 'src', 'main', 'server', 'electron-shim.ts')
const OUT_DIR = join(ROOT, 'out', 'server')

// Single source of truth for the published package name. Centralized so a future
// rename is a one-line change here (the npm side would still need the standard
// deprecate + re-point migration once published).
const PACKAGE_NAME = '@stablyai/orca-server'

const wantReport = process.argv.includes('--report')

mkdirSync(OUT_DIR, { recursive: true })
// Why: the npm server package used to publish an `orca` bin; remove stale local
// output so package/tarball checks prove the Linux-safe `orca-ide` contract.
rmSync(join(OUT_DIR, 'orca.js'), { force: true })

// Why: esbuild cannot bundle .node native addons. Mark every native addon
// (and packages that optionally require one, like ssh2 -> cpu-features) as
// external so they resolve from node_modules at runtime. The prebuilt matrix
// supplies node-pty; the rest ship as normal package deps.
const NATIVE_EXTERNALS = ['node-pty', '@parcel/watcher', 'ssh2', 'cpu-features']

// esbuild plugin: treat any path ending in .node as external regardless of who
// requires it, so a transitive native addon never breaks the bundle.
const externalNativeAddons = {
  name: 'external-native-addons',
  setup(buildApi) {
    buildApi.onResolve({ filter: /\.node$/ }, (resolveArgs) => ({
      path: resolveArgs.path,
      external: true
    }))
  }
}

const result = await build({
  entryPoints: {
    'orca-server': SERVER_ENTRY,
    'orca-ide': SERVER_CLI_ENTRY
  },
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outdir: OUT_DIR,
  entryNames: '[name]',
  // Why: some deps (jsonc-parser) ship a UMD `main` whose conditional
  // require('./impl/...') esbuild cannot statically resolve. Preferring the
  // ESM `module` field bundles the analyzable ESM entry instead.
  mainFields: ['module', 'main'],
  conditions: ['node', 'import', 'require'],
  external: NATIVE_EXTERNALS,
  plugins: [externalNativeAddons],
  // Alias electron to the throwing shim so the bundle carries no real electron.
  alias: { electron: ELECTRON_SHIM },
  sourcemap: false,
  minify: !wantReport,
  metafile: true,
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': '"production"' }
})

if (wantReport) {
  const metaPath = join(OUT_DIR, 'metafile.json')
  writeFileSync(metaPath, JSON.stringify(result.metafile, null, 2))

  // Find every module that imported the electron shim — these are the files
  // still reaching Electron through the bundle (should be only the shim's own
  // re-exporters once abstractions are complete).
  const shimImporters = new Set()
  for (const [path, info] of Object.entries(result.metafile.inputs)) {
    for (const imp of info.imports ?? []) {
      if (imp.path.includes('electron-shim')) {
        shimImporters.add(path)
      }
    }
  }
  console.log(`\nMetafile: ${metaPath}`)
  console.log(`Modules resolving the electron shim: ${shimImporters.size}`)
  for (const p of [...shimImporters].sort()) {
    console.log(`  - ${p}`)
  }
}

// Emit a package.json next to the CJS bundle so the published package is
// self-correct. CRITICAL: type must be "commonjs" — the bundle is CJS and would
// fail to load (require() inside an ESM context) if the package were ESM. The
// native externals are declared as deps so `npm install` provides them; node-pty
// is the one ABI-sensitive module (the prebuilt matrix makes it a no-build
// install on supported platforms, with a source-compile fallback).
const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const externalDepVersion = (name) => rootPkg.dependencies?.[name] ?? '*'
const serverPkg = {
  name: PACKAGE_NAME,
  version: rootPkg.version,
  description: 'Headless, Electron-free Orca runtime server',
  type: 'commonjs',
  bin: { 'orca-ide': './orca-ide.js' },
  main: './orca-server.js',
  // Why: limit the published tarball to the runtime artifacts. Without this npm
  // would include stray files in OUT_DIR (metafile.json, etc.). The prebuilts
  // dir + scripts are load-bearing for the toolchain-free node-pty install.
  files: ['orca-ide.js', 'orca-server.js', 'package.json', 'scripts/', 'prebuilds/'],
  // Why: after deps install, drop the matching shipped node-pty prebuilt into
  // place so no compiler is needed on supported platforms. Falls back silently
  // to node-pty's own source build when no prebuilt matches (see the script).
  scripts: { postinstall: 'node ./scripts/install-node-pty-prebuilt.mjs' },
  dependencies: {
    'node-pty': externalDepVersion('node-pty'),
    ssh2: externalDepVersion('ssh2'),
    ws: externalDepVersion('ws'),
    tweetnacl: externalDepVersion('tweetnacl')
  },
  optionalDependencies: {
    '@parcel/watcher': externalDepVersion('@parcel/watcher'),
    bufferutil: '*',
    'utf-8-validate': '*'
  },
  // Scoped package → must publish with public access (matches @stablyai/*).
  publishConfig: { access: 'public', registry: 'https://registry.npmjs.org' },
  engines: { node: '>=20' }
}
writeFileSync(join(OUT_DIR, 'package.json'), JSON.stringify(serverPkg, null, 2))
// Ship the prebuilt installer next to the bundle so the postinstall can run it.
mkdirSync(join(OUT_DIR, 'scripts'), { recursive: true })
copyFileSync(
  join(ROOT, 'config', 'scripts', 'install-node-pty-prebuilt.mjs'),
  join(OUT_DIR, 'scripts', 'install-node-pty-prebuilt.mjs')
)
console.log(
  `Wrote ${join(OUT_DIR, 'package.json')} (type: commonjs, bin: orca-ide, main: orca-server.js, postinstall: prebuilt installer)`
)

console.log('\norca server bundles complete.')
