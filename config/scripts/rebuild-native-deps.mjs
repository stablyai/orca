#!/usr/bin/env node
/**
 * Why this script exists:
 *
 * The standard `electron-builder install-app-deps` uses @electron/rebuild
 * internally but does not expose the `ignoreModules` option (as of
 * electron-builder 26.x).  On Windows dev machines that lack the full
 * Visual C++ / Python build toolchain, `cpu-features@0.0.10` (an optional
 * performance dependency of `ssh2`) fails to build with node-gyp because
 * `buildcheck.gypi` is missing from the tarball.  This causes the entire
 * postinstall step to fail and prevents `pnpm install` from completing.
 *
 * This script replaces `electron-builder install-app-deps` in the postinstall
 * lifecycle.  It calls @electron/rebuild's JS API directly so that we can pass
 * `ignoreModules: ['cpu-features']` on Windows.  Skipping cpu-features is
 * safe: ssh2 detects the missing native module and falls back to pure-JS CPU
 * feature detection automatically.
 *
 * On macOS and Linux the full rebuild (including cpu-features) runs as usual.
 */

import { rebuild } from '@electron/rebuild'
import { execFileSync } from 'node:child_process'
import { existsSync, globSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const projectDir = process.cwd()
const electronVersion = JSON.parse(
  readFileSync(resolve(projectDir, 'node_modules/electron/package.json'), 'utf8')
).version

const ignoreModules = process.platform === 'win32' ? ['cpu-features'] : []

if (ignoreModules.length > 0) {
  console.log(`[rebuild] Skipping modules on Windows: ${ignoreModules.join(', ')}`)
}

// Why: @electron/rebuild's default module walker doesn't reliably find native
// modules inside pnpm's .pnpm/ store. Passing an explicit list of modules to
// rebuild via `onlyModules` ensures they're recompiled against Electron's Node
// ABI regardless of the package manager's store layout.
const NATIVE_MODULES = ['better-sqlite3', 'node-pty', 'cpu-features']
const onlyModules = NATIVE_MODULES.filter((m) => !ignoreModules.includes(m))

// Why: cpu-features ships without `buildcheck.gypi`; its own `install` script
// generates it by running `node buildcheck.js > buildcheck.gypi` before
// node-gyp. @electron/rebuild with `force: true` invokes node-gyp directly
// and bypasses that install hook, so if the file is missing (fresh install,
// store prune, or a prior failed run) node-gyp aborts with
// "buildcheck.gypi not found". Regenerate it here before rebuilding.
if (!ignoreModules.includes('cpu-features')) {
  const cpuFeatureDirs = globSync(
    'node_modules/.pnpm/cpu-features@*/node_modules/cpu-features',
    { cwd: projectDir },
  )
  for (const relDir of cpuFeatureDirs) {
    const dir = resolve(projectDir, relDir)
    const gypiPath = resolve(dir, 'buildcheck.gypi')
    if (existsSync(gypiPath)) {
      continue
    }
    try {
      const out = execFileSync(process.execPath, ['buildcheck.js'], {
        cwd: dir,
        encoding: 'utf8',
      })
      writeFileSync(gypiPath, out)
      console.log(`[rebuild] Generated ${relDir}/buildcheck.gypi`)
    } catch (/** @type {any} */ err) {
      console.error(
        `[rebuild] Failed to generate ${relDir}/buildcheck.gypi:`,
        err?.message ?? err,
      )
      process.exit(1)
    }
  }
}

try {
  await rebuild({
    buildPath: projectDir,
    electronVersion,
    ignoreModules,
    onlyModules,
    // Why: without force, @electron/rebuild skips modules it considers
    // "already built" — even when they were compiled for the wrong ABI
    // (e.g., system Node instead of Electron's embedded Node). This is
    // common after pnpm install, which compiles native modules for system
    // Node before postinstall runs this script.
    force: true,
  })
} catch (/** @type {any} */ err) {
  console.error('[rebuild] Native module rebuild failed:', err?.message ?? err)
  process.exit(1)
}
