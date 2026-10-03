#!/usr/bin/env node
// Package orcad for the pinned Node; keep module loading compatible with legacy Node launchers.
import { fork, spawnSync } from 'node:child_process'
import { build } from 'esbuild'
import {
  buildOrcadEntry,
  externalNativeAddons,
  ORCAD_EXTERNAL_MODULES,
  ORCAD_CHILD_ENTRY_POINTS
} from './orcad-entry-build.mjs'
import { createRequire } from 'node:module'
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { smokeProfileStateWorkers } from './profile-state-worker-smoke.mjs'
import { smokeForeignSqliteReaderWorker } from './foreign-sqlite-reader-worker-smoke.mjs'
import { materializeWatcherPackage } from './orcad-watcher-package.mjs'
import { stageOrcadWindowsProcessTree } from './orcad-windows-process-tree.mjs'
import {
  ORCAD_EMOJI_SHORTCODE_DATASET,
  ORCAD_FOREIGN_SQLITE_READER_ENTRY,
  ORCAD_NODE_PTY_DIR,
  ORCAD_NODE_PTY_JS_ARTIFACTS,
  ORCAD_NODE_RUNTIME_MARKER_FILENAME,
  ORCAD_PARCEL_WATCHER_ENTRY,
  ORCAD_PARCEL_WATCHER_NATIVE,
  ORCAD_SERVER_TARGET_FILENAME,
  ORCAD_VERSION_FILENAME,
  orcadNodePtySlotFiles,
  orcadRipgrepArtifact
} from '../../src/shared/orcad-artifacts.ts'
import { computeOrcadFullVersion } from './orcad-artifact-version.mjs'
import { NODE_RUNTIME_ASSETS, NODE_RUNTIME_PIN } from '../../src/shared/node-runtime-pin.ts'
import { findSlotProblems, readManifest } from './orcad-prebuild-slot-contents.mjs'
import { orcadAgentBrowserNativeName } from '../../src/shared/orcad-agent-browser-name.ts'

const ROOT = join(import.meta.dirname, '..', '..')
const OUT_DIR = process.env.ORCAD_OUT_DIR
  ? resolve(process.env.ORCAD_OUT_DIR)
  : join(ROOT, 'out', 'orcad')
// Why beside orcad.js: the watcher runs in a forked child so a native @parcel/watcher
// fault crashes that child instead of the server, and `resolveWatcherProcessEntryPath`
// looks for it in the app root. A deployment has no desktop out/main to fall back to.
const WATCHER_ENTRY = join(ROOT, ORCAD_CHILD_ENTRY_POINTS.watcher)
const WATCHER_OUT_FILE = join(OUT_DIR, 'parcel-watcher-process-entry.js')
// Why beside orcad.js: orcad forks the terminal daemon so PTYs outlive the runtime process,
// and `getDaemonEntryPath()` probes the app root for this exact filename. Without it every
// orcad restart would SIGKILL every running terminal.
const DAEMON_ENTRY = join(ROOT, ORCAD_CHILD_ENTRY_POINTS.daemon)
const DAEMON_OUT_FILE = join(OUT_DIR, 'daemon-entry.js')
// Why beside orcad.js: the hook server's OpenCode binder and the OpenCode history scanner
// start this worker from the module dir, since orcad has no Electron resources tree.
const FOREIGN_SQLITE_READER_ENTRY = join(ROOT, ORCAD_CHILD_ENTRY_POINTS.foreignSqliteReader)
const FOREIGN_SQLITE_READER_OUT_FILE = join(OUT_DIR, ORCAD_FOREIGN_SQLITE_READER_ENTRY)
const OUT_FILE = join(OUT_DIR, 'orcad.js')
const BUILD_TARGET = process.env.ORCAD_BUILD_TARGET
if (!BUILD_TARGET) {
  throw new Error('ORCAD_BUILD_TARGET is required; run `pnpm build:orcad`')
}
const [targetPlatform, targetArch] = BUILD_TARGET.split('-')
const targetIsWindows = targetPlatform === 'win32'
const runtimeAsset = NODE_RUNTIME_ASSETS[BUILD_TARGET]
if (!runtimeAsset) {
  throw new Error(`Unsupported ORCAD_BUILD_TARGET: ${BUILD_TARGET}`)
}
// Set only when the build host can run this target's runtime.
const nodeRuntimePath = process.env.ORCAD_NODE_RUNTIME_PATH || null
const PREBUILDS_DIR = process.env.ORCAD_PREBUILDS_DIR
if (!PREBUILDS_DIR) {
  throw new Error('ORCAD_PREBUILDS_DIR is required; run `pnpm build:orcad`')
}
const AGENT_BROWSER_NAME = orcadAgentBrowserNativeName(
  targetPlatform,
  targetArch,
  BUILD_TARGET.endsWith('-musl') ? 'musl' : 'glibc'
)
const AGENT_BROWSER_SOURCE = join(ROOT, 'node_modules', 'agent-browser', 'bin', AGENT_BROWSER_NAME)
const AGENT_BROWSER_OUTPUT = join(OUT_DIR, AGENT_BROWSER_NAME)
const WATCHER_MODULE_DIR = join(OUT_DIR, 'node_modules', '@parcel', 'watcher')

async function stageParcelWatcher(target) {
  const requireFromWatcher = createRequire(
    join(ROOT, 'node_modules', '@parcel', 'watcher', 'index.js')
  )
  const nativeSource = await materializeWatcherPackage(target)
  const wrapperSource = requireFromWatcher.resolve('@parcel/watcher/wrapper.js')
  mkdirSync(WATCHER_MODULE_DIR, { recursive: true })
  await build({
    stdin: {
      contents:
        `const {createWrapper}=require(${JSON.stringify(wrapperSource)});` +
        `module.exports=createWrapper(require('./watcher.node'));`,
      resolveDir: ROOT,
      sourcefile: 'orcad-parcel-watcher-entry.js'
    },
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    outfile: join(OUT_DIR, ORCAD_PARCEL_WATCHER_ENTRY),
    external: ['./watcher.node'],
    minify: true,
    sourcemap: false,
    logLevel: 'error'
  })
  copyFileSync(nativeSource, join(OUT_DIR, ORCAD_PARCEL_WATCHER_NATIVE))
}

/** node-pty's JS plus only this target's prebuild slot, laid out the way node-pty's loader looks. */
function stageNodePty(target) {
  const problems = findSlotProblems(readManifest(PREBUILDS_DIR), PREBUILDS_DIR, [target])
  if (problems.length > 0) {
    throw new Error(`[build-orcad] node-pty prebuild for ${target}: ${problems.join('; ')}`)
  }
  const slotFiles = Object.keys(readManifest(PREBUILDS_DIR).slots[target].files).sort()
  const expected = orcadNodePtySlotFiles(target).sort()
  if (slotFiles.join('\0') !== expected.join('\0')) {
    throw new Error(
      `[build-orcad] ${target} prebuild ships ${slotFiles.join(', ')}; orcad-artifacts.ts expects ${expected.join(', ')}`
    )
  }
  const sourceDir = dirname(createRequire(import.meta.url).resolve('node-pty/package.json'))
  for (const artifact of ORCAD_NODE_PTY_JS_ARTIFACTS) {
    const destination = join(OUT_DIR, artifact)
    mkdirSync(dirname(destination), { recursive: true })
    copyFileSync(join(sourceDir, artifact.slice(ORCAD_NODE_PTY_DIR.length + 1)), destination)
  }
  for (const file of expected) {
    const destination = join(OUT_DIR, ORCAD_NODE_PTY_DIR, 'build', 'Release', ...file.split('/'))
    mkdirSync(dirname(destination), { recursive: true })
    copyFileSync(join(PREBUILDS_DIR, target, ...file.split('/')), destination)
    if (file === 'spawn-helper') {
      chmodSync(destination, 0o755)
    }
  }
}

rmSync(OUT_DIR, { recursive: true, force: true })
mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(join(OUT_DIR, ORCAD_SERVER_TARGET_FILENAME), `${BUILD_TARGET}\n`)
writeFileSync(
  join(OUT_DIR, ORCAD_NODE_RUNTIME_MARKER_FILENAME),
  `${runtimeAsset.executableSha256}\n`
)
stageNodePty(BUILD_TARGET)
await stageParcelWatcher(BUILD_TARGET)
stageOrcadWindowsProcessTree(ROOT, OUT_DIR, BUILD_TARGET)
const emojiDatasetOutput = join(OUT_DIR, ORCAD_EMOJI_SHORTCODE_DATASET)
mkdirSync(dirname(emojiDatasetOutput), { recursive: true })
copyFileSync(
  createRequire(import.meta.url).resolve('emojibase-data/en/shortcodes/emojibase.json'),
  emojiDatasetOutput
)
// The desktop template omits it: ~10 MB per target, and orcad already treats it as optional.
if (existsSync(AGENT_BROWSER_SOURCE) && process.env.ORCAD_OMIT_AGENT_BROWSER !== '1') {
  copyFileSync(AGENT_BROWSER_SOURCE, AGENT_BROWSER_OUTPUT)
  if (!targetIsWindows) {
    chmodSync(AGENT_BROWSER_OUTPUT, 0o755)
  }
}
{
  const [, ripgrepPlatform, ripgrepName] = orcadRipgrepArtifact(BUILD_TARGET).split('/')
  const outputDir = join(OUT_DIR, 'ripgrep', ripgrepPlatform)
  mkdirSync(outputDir, { recursive: true })
  const outputPath = join(outputDir, ripgrepName)
  copyFileSync(
    join(ROOT, 'node_modules', '@vscode', 'ripgrep-universal', 'bin', ripgrepPlatform, ripgrepName),
    outputPath
  )
  if (!targetIsWindows) {
    chmodSync(outputPath, 0o755)
  }
}
cpSync(join(ROOT, 'resources', 'licenses', 'ripgrep'), join(OUT_DIR, 'ripgrep', 'licenses'), {
  recursive: true
})

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
    external: ORCAD_EXTERNAL_MODULES,
    plugins: [externalNativeAddons],
    metafile: true,
    minify: true,
    sourcemap: false,
    define: {
      'process.env.NODE_ENV': '"production"'
    },
    logLevel: 'error'
  })
}

const childResults = await Promise.all([
  buildForkedChild(WATCHER_ENTRY, WATCHER_OUT_FILE),
  buildForkedChild(DAEMON_ENTRY, DAEMON_OUT_FILE),
  buildForkedChild(FOREIGN_SQLITE_READER_ENTRY, FOREIGN_SQLITE_READER_OUT_FILE),
  ...['writer', 'backup'].map((role) =>
    buildForkedChild(
      join(ROOT, ORCAD_CHILD_ENTRY_POINTS[role]),
      join(OUT_DIR, `profile-state-${role}-worker-entry.js`)
    )
  )
])

const result = await buildOrcadEntry(OUT_FILE)

const output = Object.values(result.metafile.outputs).find(
  (o) => o.entryPoint === 'src/main/orcad/main.ts'
)
// Why check `original` and not just `path`: when electron is bundleable, esbuild
// rewrites `path` to the resolved file under node_modules and the naive check passes
// while the package is very much in the bundle.
// Why both metafiles: the forked children ship in the same deployment and runtime. A
// daemon-entry that reached electron would fail at fork time, on the
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
  // *names* electron, but the rollback graph can still fail to resolve under plain Node — a
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
      `[build-orcad] the bundle lost Node load compatibility.\n` +
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
      `[build-orcad] the daemon child lost Node load compatibility.\n` +
        `Expected a clean load check, got status=${daemonSmoke.status ?? 'none'} ` +
        `signal=${daemonSmoke.signal ?? 'none'} ` +
        `error=${daemonSmoke.error?.message ?? 'none'}\n${daemonSmokeOutput.slice(0, 2000)}`
    )
    process.exitCode = 1
  }
  const watcherFailure = nodeRuntimePath ? await smokeLoadWatcherChild(nodeRuntimePath) : null
  if (watcherFailure) {
    console.error(
      `[build-orcad] the watcher child failed under the bundled runtime.\n${watcherFailure}`
    )
    process.exitCode = 1
  }
}

try {
  await smokeProfileStateWorkers(OUT_DIR)
  if (nodeRuntimePath) {
    await smokeProfileStateWorkers(OUT_DIR, { runtimePath: nodeRuntimePath })
  }
} catch (error) {
  console.error('[build-orcad] profile state worker check failed:', error)
  process.exitCode = 1
}

try {
  smokeForeignSqliteReaderWorker(OUT_DIR)
  if (nodeRuntimePath) {
    smokeForeignSqliteReaderWorker(OUT_DIR, { runtimePath: nodeRuntimePath })
  }
} catch (error) {
  console.error('[build-orcad] foreign SQLite reader worker check failed:', error)
  process.exitCode = 1
}

// Why a content hash and not ORCAD_VERSION alone: the remote install directory is keyed on
// this string, so two different builds carrying one version would share a directory — and an
// already-`.install-complete` dir is never re-uploaded. The deploy would silently run stale
// bytes while reporting the new version.
if (process.exitCode !== 1) {
  const fullVersion = computeOrcadFullVersion(OUT_DIR, {
    target: BUILD_TARGET,
    agentBrowserFilename: AGENT_BROWSER_NAME
  })
  writeFileSync(join(OUT_DIR, ORCAD_VERSION_FILENAME), fullVersion)
  console.log(
    `[build-orcad] ok — ${fullVersion}, ${(output.bytes / 1024 / 1024).toFixed(2)} MB, ${Object.keys(output.inputs).length} modules, zero electron and node:sqlite imports, Node ${NODE_RUNTIME_PIN.version} referenced.`
  )
}

// Verify the shipped native watcher actually subscribes under the bundled runtime.
async function smokeLoadWatcherChild(runtimePath) {
  const probeDir = mkdtempSync(join(tmpdir(), 'orcad-watcher-smoke-'))
  const child = fork(WATCHER_OUT_FILE, [], {
    execPath: runtimePath,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    windowsHide: true
  })
  let stderr = ''
  let subscribed = false
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk)
  })
  try {
    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        resolve(`Watcher did not complete its subscription within 30s.\n${stderr.slice(0, 2000)}`)
      }, 30_000)
      const settle = (failure) => {
        clearTimeout(timer)
        resolve(failure)
      }
      child.on('message', (message) => {
        subscribed ||= message?.op === 'subscribed'
        if (message?.op === 'subscribed' || message?.op === 'subscribe-failed') {
          child.disconnect()
        }
      })
      child.on('error', (error) => settle(`fork failed: ${error.message}`))
      // Why exit and not disconnect: the child exits 0 on disconnect, so a non-zero code
      // or a signal here is a load failure rather than a clean teardown.
      child.on('exit', (code, signal) =>
        settle(
          code === 0 && subscribed
            ? null
            : `subscribed=${subscribed} exit code=${code} signal=${signal}\n${stderr.slice(0, 2000)}`
        )
      )
      child.send({ op: 'subscribe', id: 1, dir: probeDir, opts: {} })
    })
  } finally {
    rmSync(probeDir, { recursive: true, force: true })
  }
}
