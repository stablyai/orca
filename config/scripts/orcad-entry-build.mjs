import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { ORCAD_SERVER_ENTRY_FILENAME } from '../../src/shared/orcad-artifacts.ts'

const root = join(import.meta.dirname, '..', '..')

export const ORCAD_ENTRY_POINT = 'src/main/orcad/main.ts'
export const ORCAD_LAUNCHER_ENTRY_POINT = 'src/main/orcad/launcher.ts'
export const ORCAD_CHILD_ENTRY_POINTS = {
  watcher: 'src/main/ipc/parcel-watcher-process-entry.ts',
  daemon: 'src/main/daemon/daemon-entry.ts',
  writer: 'src/main/persistence/profile-state/profile-state-writer-worker-entry.ts',
  backup: 'src/main/persistence/profile-state/profile-state-backup-worker-entry.ts',
  foreignSqliteReader: 'src/main/foreign-sqlite-readers/foreign-sqlite-reader-entry.ts',
  portScanCommandWorker: 'src/main/ports/port-scan-command-worker-entry.ts',
  sessionScanner: 'src/main/ai-vault/session-scanner-service-entry.ts'
}

/** Each child ships flat beside orcad.js under its source basename; the runtime resolvers look there. */
export function orcadChildOutputFilename(entryPoint) {
  return basename(entryPoint).replace(/\.ts$/, '.js')
}

export const ORCAD_EXTERNAL_MODULES = ['electron', 'node-pty', '@parcel/watcher', 'fsevents']

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
    entryPoints: [join(root, ORCAD_ENTRY_POINT)],
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

export function buildOrcadLauncher(outfile) {
  const serverSha256 = createHash('sha256')
    .update(readFileSync(join(dirname(outfile), ORCAD_SERVER_ENTRY_FILENAME)))
    .digest('hex')
  return build({
    entryPoints: [join(root, ORCAD_LAUNCHER_ENTRY_POINT)],
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    outfile,
    metafile: true,
    minify: true,
    sourcemap: false,
    define: { ORCAD_SERVER_SHA256: JSON.stringify(serverSha256) },
    logLevel: 'error'
  })
}
