#!/usr/bin/env node

// NSIS repack recopies cached elevate.exe over signed resource; replace toolset cache first. Old <cache>/nsis search missed actual layouts and shipped unsigned helpers.

import { copyFileSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, platform as osPlatform, tmpdir } from 'node:os'
import { join, parse, resolve } from 'node:path'

const require = createRequire(import.meta.url)

const ELEVATE_EXE = 'elevate.exe'

// Scan legacy/unified nsis release dirs; customNsisBinary extracts under URL-derived names outside nsis*. Only app-builder-lib’s authoritative probe proves replacement.
const NSIS_RELEASE_DIR = /^nsis(?:[-@].*)?$/i

// Search bundle root one level below release dir; recursive Contrib walk is slow and risks unrelated matches.
const MAX_DEPTH = 3

function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

// Mirror app-builder-lib’s getCacheDirectory locally so cache-root resolution still works when the package cannot load.
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

// Include cached NSIS elevate.exe files and ELECTRON_BUILDER_NSIS_DIR override.
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

// Ask app-builder-lib for exact packed path; return probe failure so caller cannot silently accept scan-only evidence.
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

// Replace every cached copy: elevate is standalone, and pack-time toolset choice is otherwise ambiguous.
// toolsetReplaced proves authoritative copy changed; replaced.length alone can be satisfied by stale restored release dirs.
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

// Classify swap results separately to test stale-copy success while authoritative packed copy remains unchanged.
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
    // Fail scan-only success: stale prefix-restored cache can satisfy it while packed bundle lives outside scan patterns.
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

// Exit nonzero before repack can restore unsigned helper. Workflow continue-on-error preserves release progress while surfacing the missed swap.
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
