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
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const projectDir = process.cwd()
const electronVersion = JSON.parse(
  readFileSync(resolve(projectDir, 'node_modules/electron/package.json'), 'utf8')
).version

const ignoreModules = process.platform === 'win32' ? ['cpu-features'] : []

if (ignoreModules.length > 0) {
  console.log(`[rebuild] Skipping modules on Windows: ${ignoreModules.join(', ')}`)
}

try {
  await rebuild({
    buildPath: projectDir,
    electronVersion,
    ignoreModules,
  })
} catch (/** @type {any} */ err) {
  console.error('[rebuild] Native module rebuild failed:', err?.message ?? err)
  process.exit(1)
}
