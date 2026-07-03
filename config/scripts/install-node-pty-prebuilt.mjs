#!/usr/bin/env node
/**
 * Toolchain-free node-pty install for @stablyai/orca-server.
 *
 * node-pty's own loader (node_modules/node-pty/lib/utils.js) looks for the
 * native addon in: build/Release, build/Debug, then prebuilds/<platform>-<arch>.
 * Crucially it does NOT distinguish glibc from musl, so a glibc binary dropped
 * into prebuilds/linux-x64 would be loaded on Alpine and crash at dlopen.
 *
 * This script runs as the @stablyai/orca-server postinstall. It:
 *   1. detects the runtime platform/arch AND libc (glibc vs musl),
 *   2. finds the matching shipped prebuilt at
 *      <server>/prebuilds/<platform>-<arch>-<libc>/pty.node,
 *   3. copies it into node-pty's build/Release/pty.node so node-pty loads it
 *      with no compiler,
 *   4. if no matching prebuilt exists, leaves node-pty as-is so its own
 *      source-build (requires a toolchain) remains the fallback.
 *
 * Exit code is always 0: a missing prebuilt is not fatal (source-build covers
 * it); we only log so the user knows which path was taken.
 */
import { existsSync, copyFileSync, mkdirSync, readFileSync, chmodSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const here = import.meta.dirname

function detectLibc() {
  // Why: musl runtimes (Alpine) have no glibc; process.report exposes
  // glibcVersionRuntime only on glibc. This avoids shelling out to `ldd`.
  try {
    const report = process.report?.getReport?.()
    const header = report && typeof report === 'object' ? report.header : undefined
    if (header && typeof header === 'object' && 'glibcVersionRuntime' in header) {
      return 'glibc'
    }
    return 'musl'
  } catch {
    return 'glibc'
  }
}

function log(msg) {
  console.log(`[orca-server:node-pty] ${msg}`)
}

function readManifest() {
  try {
    return JSON.parse(readFileSync(join(here, '..', 'prebuilds', 'manifest.json'), 'utf8'))
  } catch {
    return null
  }
}

function main() {
  if (process.platform === 'win32') {
    log('windows: relying on node-pty prebuilt/source path, nothing to do')
    return
  }

  const libc = process.platform === 'linux' ? detectLibc() : 'none'
  const slot =
    process.platform === 'linux'
      ? `${process.platform}-${process.arch}-${libc}`
      : `${process.platform}-${process.arch}`
  const prebuilt = join(here, '..', 'prebuilds', slot, 'pty.node')

  if (!existsSync(prebuilt)) {
    log(`no shipped prebuilt for ${slot}; node-pty will source-build (needs a toolchain)`)
    return
  }

  const manifest = readManifest()
  if (
    manifest &&
    typeof manifest.nodeAbi === 'string' &&
    manifest.nodeAbi !== process.versions.modules
  ) {
    log(
      `WARNING: prebuilt ABI ${manifest.nodeAbi} does not match runtime ABI ${process.versions.modules}; leaving node-pty as-is`
    )
    return
  }

  let nodePtyDir
  try {
    nodePtyDir = dirname(require.resolve('node-pty/package.json'))
  } catch {
    log('node-pty not resolvable; skipping prebuilt install')
    return
  }

  const releaseDir = join(nodePtyDir, 'build', 'Release')
  mkdirSync(releaseDir, { recursive: true })
  const dest = join(releaseDir, 'pty.node')
  copyFileSync(prebuilt, dest)
  log(`installed prebuilt ${slot} -> ${dest} (no compiler needed)`)

  // Why: on Unix node-pty posix_spawns build/Release/spawn-helper; it must be
  // shipped + placed alongside pty.node with the executable bit, or every PTY
  // spawn fails with ENOENT helper=.../spawn-helper.
  if (process.platform !== 'win32') {
    const helperSrc = join(here, '..', 'prebuilds', slot, 'spawn-helper')
    if (existsSync(helperSrc)) {
      const helperDest = join(releaseDir, 'spawn-helper')
      copyFileSync(helperSrc, helperDest)
      chmodSync(helperDest, 0o755)
      log(`installed spawn-helper -> ${helperDest}`)
    } else {
      log(`WARNING: no spawn-helper in prebuilt slot ${slot}; PTY spawn will fail`)
    }
  }

  // Sanity: confirm the version matches what the manifest recorded, if present.
  if (manifest) {
    const installed = require('node-pty/package.json').version
    if (manifest.version && manifest.version !== installed) {
      log(`WARNING: prebuilt built for node-pty ${manifest.version} but installed ${installed}`)
    }
  }
}

main()
