#!/usr/bin/env node
/**
 * Build one node-pty prebuilt for the CURRENT platform/arch/libc and file it in orcad's
 * prebuilds matrix, so a deployment target needs no C/C++ toolchain.
 *
 * node-pty is the only ABI-sensitive native module orcad requires. It is also PATCHED in
 * this repo (config/patches/node-pty@1.1.0.patch), and that patch is the glibc-floor fix:
 * `.symver` pins on openpty/forkpty/pthread_sigmask plus the `--no-as-needed` ldflags that
 * keep libutil/libpthread in DT_NEEDED. An upstream prebuilt has none of it and reproduces
 * #9902. So the matrix is compiled from patched sources here, and this script refuses to
 * run if the patch is not in the tree it is about to compile.
 *
 * orcad pins its own Node runtime, so the ABI dimension is fixed and the matrix varies
 * only platform/arch/libc:
 *   linux-x64-glibc, linux-arm64-glibc, linux-x64-musl, linux-arm64-musl,
 *   darwin-x64, darwin-arm64
 *
 * CI runs this once per slot, each inside the container that owns that libc/arch, and
 * merges the resulting `out/orcad/prebuilds` trees. `--slot=<name>` forces the label so
 * the glibc/musl distinction is recorded from the container rather than detected.
 *
 * Usage:
 *   node config/scripts/build-orcad-prebuilds.mjs [--slot=linux-x64-musl]
 *   node config/scripts/build-orcad-prebuilds.mjs --require-slots   # release gate
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'

const require = createRequire(import.meta.url)
const ROOT = join(import.meta.dirname, '..', '..')
const PREBUILDS_DIR = join(ROOT, 'out', 'orcad', 'prebuilds')

/** Every slot a shipped matrix must fill. The single source of truth for the matrix. */
export const MATRIX_SLOTS = [
  'linux-x64-glibc',
  'linux-arm64-glibc',
  'linux-x64-musl',
  'linux-arm64-musl',
  'darwin-x64',
  'darwin-arm64'
]

/**
 * Why the report header and not `ldd`: `glibcVersionRuntime` is present only when the
 * process is linked against glibc, and musl images have no `ldd` worth parsing.
 */
export function detectLibc(platform = process.platform, header = readReportHeader()) {
  if (platform !== 'linux') {
    return 'none'
  }
  return header && typeof header === 'object' && 'glibcVersionRuntime' in header ? 'glibc' : 'musl'
}

function readReportHeader() {
  try {
    return process.report?.getReport?.()?.header
  } catch {
    return undefined
  }
}

export function slotName(argv = process.argv, platform = process.platform, arch = process.arch) {
  const forced = argv.find((arg) => arg.startsWith('--slot='))
  if (forced) {
    return forced.slice('--slot='.length)
  }
  const libc = detectLibc(platform)
  return libc === 'none' ? `${platform}-${arch}` : `${platform}-${arch}-${libc}`
}

/**
 * The patch is what holds the Ubuntu 20.04 floor. Compiling without it produces a binary
 * that loads fine on the build host and dies on the target — the exact failure the matrix
 * exists to prevent, now baked into a shipped artifact instead of a first-connect error.
 */
export function assertNodePtyPatchApplied(nodePtyDir) {
  const bindingGyp = readFileSync(join(nodePtyDir, 'binding.gyp'), 'utf8')
  const ptySource = readFileSync(join(nodePtyDir, 'src', 'unix', 'pty.cc'), 'utf8')
  const missing = []
  if (!bindingGyp.includes('--no-as-needed,-l:libutil.so.1')) {
    missing.push("binding.gyp is missing the '--no-as-needed,-l:libutil.so.1' ldflag")
  }
  if (!ptySource.includes('.symver openpty,openpty@')) {
    missing.push('src/unix/pty.cc is missing the .symver glibc pins')
  }
  if (missing.length > 0) {
    throw new Error(
      [
        '[orcad-prebuilds] refusing to build: config/patches/node-pty@1.1.0.patch is not applied.',
        ...missing.map((line) => `  - ${line}`),
        'A prebuilt compiled without it will not load on Ubuntu 20.04 (see',
        'docs/reference/linux-glibc-compatibility.md and #9902). Run `pnpm install` to apply patches.'
      ].join('\n')
    )
  }
}

export function readManifest(prebuildsDir) {
  try {
    return JSON.parse(readFileSync(join(prebuildsDir, 'manifest.json'), 'utf8'))
  } catch {
    return null
  }
}

/**
 * Why merge rather than overwrite: CI builds one slot per container and merges the trees.
 * A manifest that records only the last slot would erase every other container's record,
 * and `--require-slots` would then reject a complete matrix.
 */
export function mergeManifest(existing, next) {
  const slots = new Set([...(existing?.slots ?? []), next.slot])
  return {
    module: 'node-pty',
    version: next.version,
    nodeAbi: next.nodeAbi,
    slots: [...slots].sort()
  }
}

function nodePtyDir() {
  return dirname(require.resolve('node-pty/package.json'))
}

function compileNodePty(dir) {
  const built = join(dir, 'build', 'Release', 'pty.node')
  if (existsSync(built)) {
    console.log(`[orcad-prebuilds] reusing existing build at ${built}`)
    return built
  }
  console.log('[orcad-prebuilds] compiling node-pty from patched source ...')
  const result = spawnSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['node-gyp', 'rebuild'],
    {
      cwd: dir,
      stdio: 'inherit',
      env: process.env,
      windowsHide: true
    }
  )
  if (result.status !== 0) {
    throw new Error(`[orcad-prebuilds] node-gyp rebuild failed (status ${result.status})`)
  }
  if (!existsSync(built)) {
    throw new Error(`[orcad-prebuilds] node-gyp succeeded but ${built} is missing`)
  }
  return built
}

function requireSlots() {
  const manifest = readManifest(PREBUILDS_DIR)
  const have = new Set(manifest?.slots ?? [])
  const missing = MATRIX_SLOTS.filter((slot) => !have.has(slot))
  if (missing.length > 0) {
    console.error(
      `[orcad-prebuilds] matrix incomplete — missing ${missing.join(', ')}. ` +
        'Hosts on those slots fall back to a source build and need a C/C++ toolchain.'
    )
    process.exitCode = 1
    return
  }
  console.log(`[orcad-prebuilds] matrix complete — ${MATRIX_SLOTS.length} slots`)
}

function build() {
  const dir = nodePtyDir()
  assertNodePtyPatchApplied(dir)
  const slot = slotName()
  const slotDir = join(PREBUILDS_DIR, slot)
  mkdirSync(slotDir, { recursive: true })

  const builtBinary = compileNodePty(dir)
  copyFileSync(builtBinary, join(slotDir, 'pty.node'))
  console.log(`[orcad-prebuilds] stored ${slot}/pty.node`)

  // Why spawn-helper ships too: on macOS node-pty posix_spawns build/Release/spawn-helper,
  // so a slot without it installs cleanly and then fails ENOENT the first time a user
  // opens a terminal. binding.gyp builds the helper only under OS=="mac"; every other
  // platform forks directly, so demanding one there fails a healthy Linux slot build.
  if (process.platform === 'darwin') {
    const helperSource = join(dirname(builtBinary), 'spawn-helper')
    if (!existsSync(helperSource)) {
      throw new Error(`[orcad-prebuilds] spawn-helper missing at ${helperSource}`)
    }
    copyFileSync(helperSource, join(slotDir, 'spawn-helper'))
    console.log(`[orcad-prebuilds] stored ${slot}/spawn-helper`)
  }

  // The static floor gate, applied to the artifact we are about to ship rather than only
  // to the packaged desktop app. objdump is Linux-only, which is where the floor lives.
  if (process.platform === 'linux') {
    const { verifyLinuxGlibcFloor } = require('./verify-linux-glibc-floor.cjs')
    verifyLinuxGlibcFloor(slotDir)
  }

  const manifest = mergeManifest(readManifest(PREBUILDS_DIR), {
    slot,
    version: require('node-pty/package.json').version,
    nodeAbi: process.versions.modules
  })
  writeFileSync(join(PREBUILDS_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(
    `[orcad-prebuilds] manifest: node-pty ${manifest.version}, ABI ${manifest.nodeAbi}, slots ${manifest.slots.join(', ')}`
  )
}

if (process.argv[1] && process.argv[1].endsWith('build-orcad-prebuilds.mjs')) {
  if (process.argv.includes('--require-slots')) {
    requireSlots()
  } else {
    build()
  }
}
