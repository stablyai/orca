'use strict'
// Share fingerprint-keyed builds across worktrees; only native-client.mjs writes. Expo requires CommonJS.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createRequire } = require('node:module')

const CACHE_DIR_ENV = 'ORCA_MOBILE_NATIVE_BUILD_CACHE_DIR'
// Only native-client.mjs enables writes after regeneration, preventing stale native projects from poisoning the cache.
const CACHE_MODE_ENV = 'ORCA_MOBILE_NATIVE_BUILD_CACHE_MODE'
const ENTRIES_KEPT_PER_PLATFORM = 3
const STAGING_PREFIX = '.staging-'
const STALE_STAGING_MS = 24 * 60 * 60 * 1000
const ARTIFACT_EXTENSIONS = ['.app', '.apk']

function resolveCacheDir(env = process.env, platform = process.platform, homedir = os.homedir()) {
  if (env[CACHE_DIR_ENV]) {
    return path.resolve(env[CACHE_DIR_ENV])
  }
  let base
  if (platform === 'darwin') {
    base = path.join(homedir, 'Library', 'Caches')
  } else if (platform === 'win32') {
    base = env.LOCALAPPDATA || path.join(homedir, 'AppData', 'Local')
  } else {
    base = env.XDG_CACHE_HOME || path.join(homedir, '.cache')
  }
  return path.join(base, 'orca-mobile', 'native-builds')
}

function buildVariant(platform, runOptions = {}) {
  return platform === 'ios'
    ? (runOptions.configuration ?? 'Debug')
    : (runOptions.variant ?? 'debug')
}

function cacheEntryKey(platform, fingerprintHash, variant) {
  return `${platform}-${fingerprintHash}-${variant}`
}

function findCachedBuild(cacheDir, key) {
  const entryDir = path.join(cacheDir, key)
  let names
  try {
    names = fs.readdirSync(entryDir)
  } catch {
    return null
  }
  const artifact = names.find((name) => ARTIFACT_EXTENSIONS.includes(path.extname(name)))
  if (!artifact) {
    return null
  }
  // Pruning keeps the most recently used entries.
  const now = new Date()
  try {
    fs.utimesSync(entryDir, now, now)
  } catch {}
  return path.join(entryDir, artifact)
}

function storeBuild(cacheDir, key, buildPath) {
  fs.mkdirSync(cacheDir, { recursive: true })
  const artifactName = path.basename(buildPath)
  // Copy into a staging directory and rename, so a concurrent reader never sees a partial build.
  const staging = fs.mkdtempSync(path.join(cacheDir, `${STAGING_PREFIX}${key}-`))
  const entryDir = path.join(cacheDir, key)
  try {
    fs.cpSync(buildPath, path.join(staging, artifactName), {
      recursive: true,
      verbatimSymlinks: true
    })
    fs.rmSync(entryDir, { recursive: true, force: true })
    fs.renameSync(staging, entryDir)
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true })
    // Another worktree finished the same fingerprint first; its entry is equivalent.
    const concurrent = findCachedBuild(cacheDir, key)
    if (concurrent) {
      return concurrent
    }
    throw error
  }
  pruneCache(cacheDir, key.split('-')[0])
  return path.join(entryDir, artifactName)
}

function pruneCache(cacheDir, platform, keep = ENTRIES_KEPT_PER_PLATFORM, now = Date.now()) {
  let dirents
  try {
    dirents = fs.readdirSync(cacheDir, { withFileTypes: true })
  } catch {
    return []
  }
  const removed = []
  const entries = []
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) {
      continue
    }
    const fullPath = path.join(cacheDir, dirent.name)
    const mtimeMs = fs.statSync(fullPath).mtimeMs
    if (dirent.name.startsWith(STAGING_PREFIX)) {
      if (now - mtimeMs > STALE_STAGING_MS) {
        fs.rmSync(fullPath, { recursive: true, force: true })
        removed.push(dirent.name)
      }
    } else if (dirent.name.startsWith(`${platform}-`)) {
      entries.push({ name: dirent.name, fullPath, mtimeMs })
    }
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs)
  for (const entry of entries.slice(keep)) {
    fs.rmSync(entry.fullPath, { recursive: true, force: true })
    removed.push(entry.name)
  }
  return removed
}

// Resolved through expo, not a direct dependency, so it is the exact version Expo CLI runs.
function loadFingerprintModule(projectRoot) {
  const projectRequire = createRequire(path.join(projectRoot, 'package.json'))
  return createRequire(projectRequire.resolve('expo/package.json'))('@expo/fingerprint')
}

function createNativeFingerprint(projectRoot, platform) {
  return loadFingerprintModule(projectRoot).createFingerprintAsync(projectRoot, {
    platforms: [platform],
    silent: true
  })
}

// Expo CLI hashes once to look up and again to store; memoize so both use the pre-build sources.
const fingerprintHashes = new Map()

function log(message) {
  console.log(`› [native-build-cache] ${message}`)
}

// The provider hooks Expo CLI calls, plus the helpers native-client.mjs shares.
module.exports = {
  CACHE_DIR_ENV,
  CACHE_MODE_ENV,
  buildVariant,
  cacheEntryKey,
  createNativeFingerprint,
  findCachedBuild,
  loadFingerprintModule,
  pruneCache,
  resolveCacheDir,
  storeBuild,
  calculateFingerprintHash({ projectRoot, platform }) {
    const memoKey = `${projectRoot}\0${platform}`
    if (!fingerprintHashes.has(memoKey)) {
      fingerprintHashes.set(
        memoKey,
        createNativeFingerprint(projectRoot, platform).then((fingerprint) => fingerprint.hash)
      )
    }
    return fingerprintHashes.get(memoKey)
  },
  async resolveBuildCache({ platform, fingerprintHash, runOptions }) {
    if (process.env[CACHE_MODE_ENV] === 'store') {
      return null
    }
    const key = cacheEntryKey(platform, fingerprintHash, buildVariant(platform, runOptions))
    const cached = findCachedBuild(resolveCacheDir(), key)
    log(
      cached
        ? `HIT ${key}: installing the cached build`
        : `MISS ${key}: building (run \`pnpm native ensure ${platform}\` to cache it)`
    )
    return cached
  },
  async uploadBuildCache({ platform, fingerprintHash, buildPath, runOptions }) {
    if (process.env[CACHE_MODE_ENV] !== 'store') {
      return null
    }
    const key = cacheEntryKey(platform, fingerprintHash, buildVariant(platform, runOptions))
    const stored = storeBuild(resolveCacheDir(), key, buildPath)
    log(`stored ${key}`)
    return stored
  }
}
