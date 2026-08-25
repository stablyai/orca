#!/usr/bin/env node
/**
 * Bundle `orcad` — the Orca runtime served from plain Node, no Electron.
 *
 * Variant B (see docs/design/node-only-runtime-backend.html): the browser-pane and
 * speech clusters are excluded. That is not a size optimisation — those modules are
 * the only ones that statically import `node:sqlite`, so dropping them is what keeps
 * the host Node floor at 18 instead of 22.5+.
 */
import { fork, spawnSync } from 'node:child_process'
import { build } from 'esbuild'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { arch, platform, tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

const ROOT = join(import.meta.dirname, '..', '..')
const OUT_DIR = join(ROOT, 'out', 'orcad')
const ENTRY = join(ROOT, 'src/main/orcad/main.ts')
// Why beside orcad.js: the watcher runs in a forked child so a native @parcel/watcher
// fault crashes that child instead of the server, and `resolveWatcherProcessEntryPath`
// looks for it in the app root. A deployment has no desktop out/main to fall back to.
const WATCHER_ENTRY = join(ROOT, 'src/main/ipc/parcel-watcher-process-entry.ts')
const WATCHER_OUT_FILE = join(OUT_DIR, 'parcel-watcher-process-entry.js')
const AGENT_BROWSER_NAME = `agent-browser-${platform()}-${arch()}${process.platform === 'win32' ? '.exe' : ''}`
const OUT_FILE = join(OUT_DIR, 'orcad.js')
const AGENT_BROWSER_SOURCE = join(ROOT, 'node_modules', 'agent-browser', 'bin', AGENT_BROWSER_NAME)
const AGENT_BROWSER_OUTPUT = join(OUT_DIR, AGENT_BROWSER_NAME)

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
copyFileSync(AGENT_BROWSER_SOURCE, AGENT_BROWSER_OUTPUT)
if (process.platform !== 'win32') {
  chmodSync(AGENT_BROWSER_OUTPUT, 0o755)
}

await build({
  entryPoints: [WATCHER_ENTRY],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  outfile: WATCHER_OUT_FILE,
  external: EXTERNAL,
  plugins: [externalNativeAddons],
  minify: true,
  sourcemap: false,
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'error'
})

const result = await build({
  entryPoints: [ENTRY],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  outfile: OUT_FILE,
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
const sqliteImporters = new Set()
for (const [file, info] of Object.entries(result.metafile.inputs)) {
  for (const imported of info.imports ?? []) {
    const specifier = imported.original ?? imported.path
    if (specifier === 'node:sqlite') {
      sqliteImporters.add(file)
    }
  }
}

const graphErrors = []
if (electronImporters.size > 0) {
  graphErrors.push(
    `${electronImporters.size} module(s) in the bundle import electron:\n${[...electronImporters]
      .map((file) => `  - ${file}`)
      .join('\n')}`
  )
}
if (sqliteImporters.size > 0) {
  graphErrors.push(
    `${sqliteImporters.size} module(s) in the bundle import node:sqlite:\n${[...sqliteImporters]
      .map((file) => `  - ${file}`)
      .join('\n')}`
  )
}

if (graphErrors.length > 0) {
  console.error(`[build-orcad] ${graphErrors.join('\n')}`)
  // Why this can exceed the ratchet baseline: the ratchet measures the graph reachable
  // from orca-runtime + runtime-rpc, but this entry also imports ipc/pty directly to
  // install the PTY controller. Once orcad ships, it should become a ratchet entry
  // point so the two numbers cannot drift.
  process.exitCode = 1
} else {
  // Why smoke-load and not just read the metafile: the import scan proves no module
  // *names* electron, but a graph can still fail to resolve under plain Node — a
  // dynamic require, a missing native, a top-level throw. The plain-node-entry-guard
  // smoke-loads its entries for exactly this reason, and orcad cannot join that guard
  // because it is an esbuild artifact rather than a rollup input.
  const smoke = spawnSync(process.execPath, [OUT_FILE, '--orcad-smoke-load-check'], {
    encoding: 'utf8',
    timeout: 60_000
  })
  const smokeOutput = `${smoke.stdout ?? ''}${smoke.stderr ?? ''}`
  if (
    smoke.error ||
    smoke.signal ||
    !/Unknown argument: --orcad-smoke-load-check/.test(smokeOutput)
  ) {
    console.error(
      `[build-orcad] the bundle did not load under plain Node.\n` +
        `Expected argv rejection, got signal=${smoke.signal ?? 'none'} ` +
        `error=${smoke.error?.message ?? 'none'}\n${smokeOutput.slice(0, 2000)}`
    )
    process.exitCode = 1
  }
  const watcherFailure = await smokeLoadWatcherChild()
  if (watcherFailure) {
    console.error(
      `[build-orcad] the watcher child did not run under plain Node.\n${watcherFailure}`
    )
    process.exitCode = 1
  }
}

if (process.exitCode !== 1) {
  console.log(
    `[build-orcad] ok — ${(output.bytes / 1024 / 1024).toFixed(2)} MB, ${Object.keys(output.inputs).length} modules, zero electron and node:sqlite imports.`
  )
}

/**
 * Fork the shipped watcher child and drive one message through it.
 *
 * Why a real fork and not existsSync: the file being present says nothing about whether
 * its graph resolves under plain Node, and this child is only ever reached through
 * `fork()` at runtime — a broken one degrades silently to in-process watching.
 * `subscribe-started` is acked before the native module is touched, so this passes on a
 * build machine with no compiled @parcel/watcher.
 */
async function smokeLoadWatcherChild() {
  const probeDir = mkdtempSync(join(tmpdir(), 'orcad-watcher-smoke-'))
  const child = fork(WATCHER_OUT_FILE, [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  let stderr = ''
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk)
  })
  try {
    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        resolve(`No 'subscribe-started' ack within 30s.\n${stderr.slice(0, 2000)}`)
      }, 30_000)
      const settle = (failure) => {
        clearTimeout(timer)
        resolve(failure)
      }
      child.on('message', (message) => {
        if (message?.op === 'subscribe-started') {
          child.disconnect()
        }
      })
      child.on('error', (error) => settle(`fork failed: ${error.message}`))
      // Why exit and not disconnect: the child exits 0 on disconnect, so a non-zero code
      // or a signal here is a load failure rather than a clean teardown.
      child.on('exit', (code, signal) =>
        settle(code === 0 ? null : `exit code=${code} signal=${signal}\n${stderr.slice(0, 2000)}`)
      )
      child.send({ op: 'subscribe', id: 1, dir: probeDir, opts: {} })
    })
  } finally {
    rmSync(probeDir, { recursive: true, force: true })
  }
}
