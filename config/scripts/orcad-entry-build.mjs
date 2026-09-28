import { build } from 'esbuild'
import { join, resolve } from 'node:path'

const root = join(import.meta.dirname, '..', '..')

export const ORCAD_ENTRY_POINT = 'src/main/orcad/orcad-app.ts'
export const ORCAD_LAUNCHER_ENTRY_POINT = 'src/main/orcad/main.ts'
export const ORCAD_BUN_TARGET = 'es2024'
export const ORCAD_CHILD_ENTRY_POINTS = {
  watcher: 'src/main/ipc/parcel-watcher-process-entry.ts',
  daemon: 'src/main/daemon/daemon-entry.ts',
  ptyGate: 'src/main/daemon/pty-subprocess/windows-bun-pty-gate-entry.ts',
  writer: 'src/main/persistence/profile-state/profile-state-writer-worker-entry.ts',
  backup: 'src/main/persistence/profile-state/profile-state-backup-worker-entry.ts',
  vaultService: 'src/main/ai-vault/session-scanner-service-entry.ts',
  vaultScanner: 'src/main/ai-vault/session-scanner-worker-entry.ts',
  vaultSqlite: 'src/main/ai-vault/session-scanner-opencode-sqlite-worker-entry.ts',
  wslSqlite: 'src/main/ai-vault/session-scanner-opencode-sqlite-process-entry.ts',
  transcript: 'src/main/native-chat/wsl-transcript-fs-process-entry.ts',
  portScan: 'src/main/ports/port-scan-command-worker-entry.ts'
}

export const ORCAD_EXTERNAL_MODULES = [
  'electron',
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
    entryPoints: [join(root, ORCAD_ENTRY_POINT)],
    bundle: true,
    platform: 'node',
    target: ORCAD_BUN_TARGET,
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
  return build({
    entryPoints: [join(root, ORCAD_LAUNCHER_ENTRY_POINT)],
    bundle: true,
    platform: 'node',
    target: ORCAD_BUN_TARGET,
    format: 'cjs',
    outfile,
    external: ['./orcad-app'],
    metafile: true,
    minify: true,
    logLevel: 'error'
  })
}

export function buildOrcadChildEntry(entryPoint, outfile) {
  return build({
    entryPoints: [resolve(root, entryPoint)],
    bundle: true,
    platform: 'node',
    target: ORCAD_BUN_TARGET,
    format: 'cjs',
    outfile,
    external: ORCAD_EXTERNAL_MODULES,
    plugins: [externalNativeAddons],
    metafile: true,
    minify: true,
    sourcemap: false,
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'error'
  })
}
