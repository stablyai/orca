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
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { arch, platform, tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import {
  ORCAD_VERSION,
  ORCAD_VERSION_FILENAME,
  orcadArtifactFilenames
} from '../../src/shared/orcad-artifacts.ts'

const ROOT = join(import.meta.dirname, '..', '..')
const OUT_DIR = join(ROOT, 'out', 'orcad')
const ENTRY = join(ROOT, 'src/main/orcad/main.ts')
// Why beside orcad.js: the watcher runs in a forked child so a native @parcel/watcher
// fault crashes that child instead of the server, and `resolveWatcherProcessEntryPath`
// looks for it in the app root. A deployment has no desktop out/main to fall back to.
const WATCHER_ENTRY = join(ROOT, 'src/main/ipc/parcel-watcher-process-entry.ts')
const WATCHER_OUT_FILE = join(OUT_DIR, 'parcel-watcher-process-entry.js')
// Why beside orcad.js: orcad forks the terminal daemon so PTYs outlive the runtime process,
// and `getDaemonEntryPath()` probes the app root for this exact filename. Without it every
// orcad restart would SIGKILL every running terminal.
const DAEMON_ENTRY = join(ROOT, 'src/main/daemon/daemon-entry.ts')
const DAEMON_OUT_FILE = join(OUT_DIR, 'daemon-entry.js')
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

/** Why one call per child and not one `outdir` build: esbuild mirrors each entry's source
 *  directory under `outdir`, and both children must land flat beside orcad.js — that is where
 *  their runtime resolvers look for them. */
function buildForkedChild(entryPoint, outfile) {
  return build({
    entryPoints: [entryPoint],
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    outfile,
    external: EXTERNAL,
    plugins: [externalNativeAddons],
    metafile: true,
    minify: true,
    sourcemap: false,
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'error'
  })
}

const childResults = await Promise.all([
  buildForkedChild(WATCHER_ENTRY, WATCHER_OUT_FILE),
  buildForkedChild(DAEMON_ENTRY, DAEMON_OUT_FILE)
])

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

const output = Object.values(result.metafile.outputs).find(
  (o) => o.entryPoint === 'src/main/orcad/main.ts'
)
// Why check `original` and not just `path`: when electron is bundleable, esbuild
// rewrites `path` to the resolved file under node_modules and the naive check passes
// while the package is very much in the bundle.
// Why both metafiles: the forked children ship in the same deployment and run under the
// same plain Node. A daemon-entry that reached electron would fail at fork time, on the
// path whose whole point is that terminals survive.
function collectImporters(metafiles, matches) {
  const importers = new Set()
  for (const metafile of metafiles) {
    for (const [file, info] of Object.entries(metafile.inputs)) {
      for (const imported of info.imports ?? []) {
        if (matches(imported.original ?? imported.path)) {
          importers.add(file)
        }
      }
    }
  }
  return importers
}

const metafiles = [result.metafile, ...childResults.map((child) => child.metafile)]
const electronImporters = collectImporters(
  metafiles,
  (specifier) => specifier === 'electron' || specifier.startsWith('electron/')
)
const sqliteImporters = collectImporters(metafiles, (specifier) => specifier === 'node:sqlite')

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
  // Why an exit code and not a message match: these bundles are minified onto one line, so
  // Node's uncaught-exception report echoes that whole line — which contains every string
  // literal in the bundle. A crash therefore "matches" any expected message, and a textual
  // assertion passes against a bundle that never loaded.
  const smoke = spawnSync(process.execPath, [OUT_FILE, '--orcad-smoke-load-check'], {
    encoding: 'utf8',
    timeout: 60_000
  })
  const smokeOutput = `${smoke.stdout ?? ''}${smoke.stderr ?? ''}`
  if (smoke.error || smoke.signal || smoke.status !== 0) {
    console.error(
      `[build-orcad] the bundle did not load under plain Node.\n` +
        `Expected a clean load-check exit, got status=${smoke.status ?? 'none'} ` +
        `signal=${smoke.signal ?? 'none'} ` +
        `error=${smoke.error?.message ?? 'none'}\n${smokeOutput.slice(0, 2000)}`
    )
    process.exitCode = 1
  }
  // Why require + parseArgs and not a real daemon: requiring the bundle evaluates every
  // top-level import, and calling its exported argv parser proves the entry's own code is
  // there rather than a graph that merely resolved. Booting one would need a socket, a
  // token and a PTY — `smoke:orcad-terminal` does that end to end, through orcad.
  // The verdict is carried by the exit code for the same minification reason as above.
  const daemonSmoke = spawnSync(
    process.execPath,
    [
      '-e',
      `const mod = require(${JSON.stringify(DAEMON_OUT_FILE)})\n` +
        `if (typeof mod.parseArgs !== 'function') { process.exit(3) }\n` +
        `try { mod.parseArgs([]); process.exit(4) } catch { process.exit(0) }`
    ],
    {
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, ORCA_DAEMON_ENTRY_LOAD_CHECK: '1' }
    }
  )
  const daemonSmokeOutput = `${daemonSmoke.stdout ?? ''}${daemonSmoke.stderr ?? ''}`
  if (daemonSmoke.error || daemonSmoke.signal || daemonSmoke.status !== 0) {
    console.error(
      `[build-orcad] the daemon child did not load under plain Node.\n` +
        `Expected a clean load check, got status=${daemonSmoke.status ?? 'none'} ` +
        `signal=${daemonSmoke.signal ?? 'none'} ` +
        `error=${daemonSmoke.error?.message ?? 'none'}\n${daemonSmokeOutput.slice(0, 2000)}`
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

// Why a content hash and not ORCAD_VERSION alone: the remote install directory is keyed on
// this string, so two different builds carrying one version would share a directory — and an
// already-`.install-complete` dir is never re-uploaded. The deploy would silently run stale
// bytes while reporting the new version.
if (process.exitCode !== 1) {
  const hash = createHash('sha256')
  for (const filename of orcadArtifactFilenames()) {
    const artifactPath = join(OUT_DIR, filename)
    if (!existsSync(artifactPath)) {
      throw new Error(
        `orcad declares ${filename} in ORCAD_ARTIFACTS but never emitted it. Add the build ` +
          'step, or drop it from src/shared/orcad-artifacts.ts.'
      )
    }
    hash.update(readFileSync(artifactPath))
  }
  const fullVersion = `${ORCAD_VERSION}+${hash.digest('hex').slice(0, 12)}`
  writeFileSync(join(OUT_DIR, ORCAD_VERSION_FILENAME), fullVersion)
  console.log(
    `[build-orcad] ok — ${fullVersion}, ${(output.bytes / 1024 / 1024).toFixed(2)} MB, ${Object.keys(output.inputs).length} modules, zero electron and node:sqlite imports.`
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
