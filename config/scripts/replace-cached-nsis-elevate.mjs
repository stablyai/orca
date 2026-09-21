#!/usr/bin/env node

// Why: electron-builder re-runs `CopyElevateHelper.copy` on every NSIS pack, so the
// release rebuild overwrites the SignPath-signed `resources/elevate.exe` with the
// unsigned copy sitting in the electron-builder toolset cache. The release workflow
// swapped the cached copy first, but searched `<cache>/nsis` — a directory no current
// app-builder-lib layout creates (real ones are `<cache>/nsis-3.0.4.1/nsis-3.0.4.1-<hash>/`
// and `<cache>/nsis@<toolset>/nsis-bundle-<v>-<hash>/`), so the swap silently found
// nothing and v1.4.193/v1.4.194 shipped an unsigned UAC elevation helper.

import { copyFileSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, platform as osPlatform, tmpdir } from 'node:os'
import { join, parse, resolve } from 'node:path'

const require = createRequire(import.meta.url)

const ELEVATE_EXE = 'elevate.exe'

// `nsis` (the layout the old hardcoded path assumed), `nsis-3.0.4.1` (legacy bundle via
// `getBinFromUrl`), `nsis@1.2.1` (unified bundle). Not `customNsisBinary`: the
// `nsis-<version>` key `getBinFromCustomLoc` builds is only `getBin`'s in-process promise
// key, and the extract dir is named for the custom URL's parent segment, which need not
// start with `nsis` at all. Only the app-builder-lib probe covers that layout — which is
// why the probe, not this scan, is what decides whether the swap succeeded.
const NSIS_RELEASE_DIR = /^nsis(?:[-@].*)?$/i

// elevate.exe lives at the bundle root, one level under the release dir. The legacy
// bundle carries thousands of files under Contrib/, so an unbounded walk is both slow
// and a way to match something that is not a toolset copy.
const MAX_DEPTH = 3

function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * Mirrors `getCacheDirectory` in app-builder-lib's `out/util/electronGet.js`, which is what
 * decides where the NSIS bundle is unpacked. Kept as a local port rather than an import
 * because the swap must still resolve a cache root when app-builder-lib cannot be loaded.
 */
export function resolveElectronBuilderCacheDir({
  env = process.env,
  platform = osPlatform(),
  home = homedir(),
  temp = tmpdir()
} = {}) {
  const override = env.ELECTRON_BUILDER_CACHE?.trim()
  if (override && parse(override).root) {
    return override
  }
  if (platform === 'darwin') {
    return join(home, 'Library', 'Caches', 'electron-builder')
  }
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA?.trim()
    // https://github.com/electron-userland/electron-builder/issues/1164
    const isSystemUser =
      localAppData?.toLowerCase().includes('\\windows\\system32\\') === true ||
      env.USERNAME?.trim().toLowerCase() === 'system'
    if (!localAppData || isSystemUser) {
      return join(temp, 'electron-builder-cache')
    }
    return join(localAppData, 'electron-builder', 'Cache')
  }
  const xdgCache = env.XDG_CACHE_HOME
  return xdgCache && parse(xdgCache).root
    ? join(xdgCache, 'electron-builder')
    : join(home, '.cache', 'electron-builder')
}

function collectElevateFiles(dir, depth, found) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isFile()) {
      if (entry.name.toLowerCase() === ELEVATE_EXE) {
        found.push(path)
      }
    } else if (entry.isDirectory() && depth > 1) {
      collectElevateFiles(path, depth - 1, found)
    }
  }
  return found
}

/**
 * Every cached `elevate.exe` under an NSIS release directory of `cacheDir`, plus the
 * `ELECTRON_BUILDER_NSIS_DIR` override copy when that is set.
 */
export function findCachedElevatePaths(cacheDir, { env = process.env } = {}) {
  const found = []
  const overrideDir = env.ELECTRON_BUILDER_NSIS_DIR?.trim()
  if (overrideDir && isFile(join(overrideDir, ELEVATE_EXE))) {
    found.push(join(overrideDir, ELEVATE_EXE))
  }
  let entries
  try {
    entries = readdirSync(cacheDir, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    if (entry.isDirectory() && NSIS_RELEASE_DIR.test(entry.name)) {
      collectElevateFiles(join(cacheDir, entry.name), MAX_DEPTH, found)
    }
  }
  return found
}

/**
 * The exact path `CopyElevateHelper` will pack, asked of app-builder-lib itself. Returns the
 * failure instead of logging it: an unavailable probe leaves the directory scan as the only
 * signal, and the caller has to say that out loud rather than quietly passing.
 */
export async function resolveToolsetElevatePath(projectDir = process.cwd()) {
  try {
    const configPath = require.resolve(resolve(projectDir, 'config/electron-builder.config.cjs'))
    const config = require(configPath)
    const { getNsisElevatePath } = require('app-builder-lib/out/toolsets/windows.js')
    const path = await getNsisElevatePath(config.toolsets?.nsis, config.nsis?.customNsisBinary)
    return { path, error: null }
  } catch (error) {
    return { path: null, error: error.message }
  }
}

/**
 * Replaces every cached copy rather than picking one. Which bundle the rebuild packs
 * depends on the toolset version resolved at pack time, and each cached copy is an
 * unsigned `elevate.exe` that a later pack could reach for; the helper is a standalone
 * UAC shim, not coupled to the NSIS version around it, so overwriting all of them is safe.
 *
 * `toolsetReplaced` is the signal that matters. A non-empty `replaced` only says that some
 * cached copy was rewritten, which a stale release directory carried in by the
 * `electron-builder-win-` prefix restore can satisfy on its own.
 */
export async function replaceCachedElevateHelpers({
  signedPath,
  cacheDir = resolveElectronBuilderCacheDir(),
  projectDir = process.cwd(),
  env = process.env,
  probe = resolveToolsetElevatePath
} = {}) {
  if (!isFile(signedPath)) {
    throw new Error(`Signed elevate.exe not found: ${signedPath}`)
  }
  const targets = new Set(findCachedElevatePaths(cacheDir, { env }))
  const { path: toolsetPath, error: toolsetError } = await probe(projectDir)
  if (toolsetPath != null && isFile(toolsetPath)) {
    targets.add(toolsetPath)
  }

  const replaced = []
  for (const target of targets) {
    copyFileSync(signedPath, target)
    replaced.push(target)
  }
  return {
    replaced,
    cacheDir,
    toolsetPath,
    toolsetError,
    toolsetReplaced: toolsetPath != null && replaced.includes(toolsetPath)
  }
}

/**
 * The annotations and exit code a swap result earns. Split out so every branch is testable
 * without a subprocess — including the one that made this defect class possible, where the
 * step passes because *a* cached copy was replaced while the copy the rebuild packs was not.
 */
export function summarizeSwap({ replaced, cacheDir, toolsetPath, toolsetError, toolsetReplaced }) {
  if (toolsetPath != null && !toolsetReplaced) {
    return {
      annotations: [
        {
          level: 'error',
          message:
            `app-builder-lib resolves the elevate.exe the NSIS rebuild will pack to ${toolsetPath}, ` +
            'but that path could not be replaced, so the installer will ship an unsigned UAC ' +
            'elevation helper.'
        }
      ],
      exitCode: 1
    }
  }
  if (replaced.length === 0) {
    return {
      annotations: [
        {
          level: 'error',
          message:
            `No cached elevate.exe found under ${cacheDir}; the NSIS rebuild will pack the unsigned ` +
            'helper and ship an unsigned UAC elevation binary. The electron-builder toolset cache ' +
            'layout has changed — update config/scripts/replace-cached-nsis-elevate.mjs.'
        }
      ],
      exitCode: 1
    }
  }
  if (toolsetPath == null) {
    // A green step must never quietly mean "the authoritative check did not run". The scan
    // alone is satisfiable by a stale release directory that the `electron-builder-win-`
    // prefix restore carried across a lockfile change, while the bundle the rebuild actually
    // packs sits in a directory this scan does not match.
    return {
      annotations: [
        {
          level: 'warning',
          message:
            'Could not ask app-builder-lib which elevate.exe the NSIS rebuild will pack ' +
            `(${toolsetError}); replaced ${replaced.length} copies found by scanning ${cacheDir} ` +
            'alone, which a stale release directory can satisfy while the packed copy stays unsigned.'
        }
      ],
      exitCode: 0
    }
  }
  return { annotations: [], exitCode: 0 }
}

// Why an exit code and not a warning: a swap that misses the copy the rebuild packs exits
// before that rebuild restores the unsigned helper, so a silent success here is
// indistinguishable from a release that shipped a signed one — which is how this went
// unnoticed for two releases. The workflow step is `continue-on-error`, so this annotates
// loudly without making a release unbuildable.
if (import.meta.filename === process.argv[1]) {
  const signedPath = process.argv[2]
  if (!signedPath) {
    process.stderr.write('Usage: replace-cached-nsis-elevate.mjs <signed-elevate.exe>\n')
    process.exit(2)
  }
  try {
    const result = await replaceCachedElevateHelpers({ signedPath })
    const { annotations, exitCode } = summarizeSwap(result)
    for (const { level, message } of annotations) {
      process.stdout.write(`::${level}::${message}\n`)
    }
    if (exitCode === 0) {
      for (const path of result.replaced) {
        const role = path === result.toolsetPath ? ' (the copy app-builder-lib will pack)' : ''
        process.stdout.write(`Replaced ${path} with the SignPath-signed copy.${role}\n`)
      }
    }
    process.exit(exitCode)
  } catch (error) {
    process.stdout.write(`::error::Could not replace the cached elevate.exe: ${error.message}\n`)
    process.exit(1)
  }
}
