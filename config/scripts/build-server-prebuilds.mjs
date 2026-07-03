#!/usr/bin/env node
/**
 * Produce a node-pty prebuilt for the CURRENT platform/arch/libc and store it in
 * the @stablyai/orca-server prebuilds matrix slot. node-pty is the only ABI-sensitive
 * native module @stablyai/orca-server ships, and it is patched (config/patches), so
 * upstream prebuilds are unusable and a source build is otherwise required at
 * install time.
 *
 * Because @stablyai/orca-server pins/ships its Node runtime, the ABI dimension is fixed;
 * the matrix only varies platform/arch/libc:
 *   linux-x64-glibc, linux-arm64-glibc, linux-x64-musl, linux-arm64-musl,
 *   darwin-x64, darwin-arm64.
 *
 * This script compiles node-pty in the current environment (CI runs it once per
 * libc/arch in the matching container) and copies the resulting pty.node into
 * out/server/prebuilds/<slot>/. The toolchain-free install side is
 * install-node-pty-prebuilt.mjs, which selects the right slot at install time.
 *
 * Run with --slot=<name> to force the slot label (CI sets this explicitly so the
 * musl/glibc distinction is recorded correctly regardless of detection).
 */
import { mkdirSync, writeFileSync, existsSync, copyFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'

const __dirname = import.meta.dirname
const ROOT = join(__dirname, '..', '..')
const PREBUILDS_DIR = join(ROOT, 'out', 'server', 'prebuilds')
const require = createRequire(import.meta.url)

function detectLibc() {
  try {
    const report = process.report?.getReport?.()
    const header = report && typeof report === 'object' ? report.header : undefined
    return header && 'glibcVersionRuntime' in header ? 'glibc' : 'musl'
  } catch {
    return 'glibc'
  }
}

function slotName() {
  const forced = process.argv.find((a) => a.startsWith('--slot='))
  if (forced) {
    return forced.slice('--slot='.length)
  }
  if (process.platform === 'linux') {
    return `${process.platform}-${process.arch}-${detectLibc()}`
  }
  return `${process.platform}-${process.arch}`
}

function nodePtyDir() {
  return dirname(require.resolve('node-pty/package.json'))
}

function nodePtyVersion() {
  try {
    return require('node-pty/package.json').version
  } catch {
    return 'unknown'
  }
}

// Compile node-pty against the current Node ABI (the patched source is already
// in node_modules via pnpm). node-gyp rebuild produces build/Release/pty.node.
function compileNodePty() {
  const dir = nodePtyDir()
  const built = join(dir, 'build', 'Release', 'pty.node')
  if (existsSync(built)) {
    console.log('[prebuilds] node-pty already built at', built)
    return built
  }
  console.log('[prebuilds] compiling node-pty via node-gyp rebuild ...')
  const result = spawnSync('npx', ['node-gyp', 'rebuild'], {
    cwd: dir,
    stdio: 'inherit',
    env: process.env
  })
  if (result.status !== 0) {
    throw new Error(`node-gyp rebuild failed (status ${result.status})`)
  }
  if (!existsSync(built)) {
    throw new Error(`node-gyp succeeded but ${built} is missing`)
  }
  return built
}

const slot = slotName()
mkdirSync(join(PREBUILDS_DIR, slot), { recursive: true })

const builtBinary = compileNodePty()
const dest = join(PREBUILDS_DIR, slot, 'pty.node')
copyFileSync(builtBinary, dest)
console.log(`[prebuilds] stored ${slot}/pty.node`)

// Why: on Unix node-pty also needs the `spawn-helper` executable it posix_spawns
// (build/Release/spawn-helper). Ship it alongside pty.node or every spawn fails
// with ENOENT helper=.../spawn-helper. Windows has no spawn-helper.
if (process.platform !== 'win32') {
  const helperSrc = join(dirname(builtBinary), 'spawn-helper')
  if (existsSync(helperSrc)) {
    const helperDest = join(PREBUILDS_DIR, slot, 'spawn-helper')
    copyFileSync(helperSrc, helperDest)
    console.log(`[prebuilds] stored ${slot}/spawn-helper`)
  } else {
    console.warn(`[prebuilds] WARNING: spawn-helper not found at ${helperSrc}`)
  }
}

// Record/refresh the manifest (version + node ABI it was built against).
const manifest = {
  module: 'node-pty',
  version: nodePtyVersion(),
  nodeAbi: process.versions.modules,
  builtSlot: slot
}
writeFileSync(join(PREBUILDS_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2))
console.log(
  `[prebuilds] manifest: node-pty ${manifest.version}, ABI ${manifest.nodeAbi}, slot ${slot}`
)
