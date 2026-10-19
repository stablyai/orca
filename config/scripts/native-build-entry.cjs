'use strict'

const { existsSync, realpathSync } = require('node:fs')
const { release } = require('node:os')
const { join, relative, isAbsolute } = require('node:path')

/**
 * Per-ABI native build entries inside a package dir that other worktrees share.
 *
 * pnpm's global virtual store gives every worktree the same physical package dir, so an
 * in-place `build/Release` rebuild in one worktree replaces the binary another is running.
 * A shared package instead gets one immutable `build/<entry>` per ABI, published atomically
 * and never rebuilt. The patched loaders (config/patches/node-pty@1.1.0.patch and
 * @vscode__windows-process-tree@0.8.0.patch) try that dir before build/Release, and must
 * compute the same name -- `native-build-entry.test.mjs` holds them to it.
 */

const ENTRY_PREFIX = 'orca-'

/** How each shared native package is built and which runtime its binary is tied to. */
const NATIVE_BUILD_PACKAGES = {
  // Both are node-addon-api (N-API): one binary loads in Node and Electron alike.
  'node-pty': { abi: 'napi' },
  '@vscode/windows-process-tree': { abi: 'napi' }
}

/**
 * The entry dir name for `moduleName` on this runtime. N-API binaries are keyed by
 * platform-arch only; anything else is tied to NODE_MODULE_VERSION, which already differs
 * between Node and every Electron major.
 */
function nativeBuildEntryName(
  moduleName,
  { platform = process.platform, arch = process.arch, modules = process.versions.modules } = {}
) {
  const descriptor = NATIVE_BUILD_PACKAGES[moduleName]
  if (!descriptor) {
    throw new Error(`${moduleName} has no shared native build descriptor`)
  }
  const abi = descriptor.abi === 'napi' ? 'napi' : `abi${modules}`
  return `${ENTRY_PREFIX}${abi}-${platform}-${arch}`
}

function nativeBuildEntryDir(packageDir, moduleName, target) {
  return join(packageDir, 'build', nativeBuildEntryName(moduleName, target))
}

/** The dir the patched loader reads: the published entry when there is one, else build/Release. */
function loadedNativeBuildDir(packageDir, moduleName, target) {
  const entryDir = nativeBuildEntryDir(packageDir, moduleName, target)
  return existsSync(entryDir) ? entryDir : join(packageDir, 'build', 'Release')
}

/** node-pty's own choice: ConPTY from Windows build 18309, winpty below it. */
function nodePtyNativeModuleName(platform = process.platform, osRelease = release()) {
  if (platform !== 'win32') {
    return 'pty'
  }
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(osRelease)
  return match && Number.parseInt(match[3], 10) >= 18309 ? 'conpty' : 'pty'
}

/** Every published, staging and quarantined entry name, for packaging to strip. */
function isNativeBuildEntryName(name) {
  return name.startsWith(ENTRY_PREFIX)
}

/** electron-builder ignore globs for in-flight staging and quarantine trees (shared-tree-publish.mjs). */
const TRANSIENT_NATIVE_BUILD_ENTRY_FILTER = [`!build/${ENTRY_PREFIX}*.{staging,unusable}-*{,/**/*}`]

/**
 * Whether `packageDir` physically lives outside this project, i.e. another worktree can load it.
 * Why realpath: under the global virtual store node_modules/<pkg> is a link into the store.
 */
function isSharedPackageDir(packageDir, projectDir) {
  try {
    const rel = relative(realpathSync(projectDir), realpathSync(packageDir))
    return rel.startsWith('..') || isAbsolute(rel)
  } catch {
    return false
  }
}

/** Whether `moduleName` is installed in a package dir other worktrees share and can be built beside. */
function isSharedNativePackage(moduleName, projectDir) {
  if (!NATIVE_BUILD_PACKAGES[moduleName]) {
    return false
  }
  try {
    return isSharedPackageDir(resolveNativePackageDir(moduleName, projectDir), projectDir)
  } catch {
    return false // Not installed: an optional dependency off its platform.
  }
}

/** The project's own top-level link, the same path every Orca native script already reads. */
function resolveNativePackageDir(moduleName, projectDir) {
  const packageDir = join(projectDir, 'node_modules', ...moduleName.split('/'))
  if (!existsSync(join(packageDir, 'package.json'))) {
    throw new Error(`${moduleName} is not installed in ${projectDir}`)
  }
  return packageDir
}

/** The files a node-pty source build must leave in whichever dir the loader reads. */
function nodePtyBuildArtifactPaths(nodePtyDir, platform = process.platform) {
  const buildDir = loadedNativeBuildDir(nodePtyDir, 'node-pty')
  if (platform === 'win32') {
    return ['conpty.node', 'conpty/conpty.dll', 'conpty/OpenConsole.exe'].map((file) =>
      join(buildDir, file)
    )
  }
  // Why: node-pty only builds spawn-helper on macOS; Linux builds only pty.node.
  return ['pty.node', ...(platform === 'darwin' ? ['spawn-helper'] : [])].map((file) =>
    join(buildDir, file)
  )
}

/** A `loadNativeModule` dir holding Orca's source build rather than an upstream prebuild. */
function isSourceBuildDir(nativeDir) {
  if (typeof nativeDir !== 'string') {
    return false
  }
  const dir = nativeDir.replace(/\\/g, '/')
  return dir.includes('build/Release/') || dir.includes(`build/${ENTRY_PREFIX}`)
}

module.exports = {
  NATIVE_BUILD_PACKAGES,
  TRANSIENT_NATIVE_BUILD_ENTRY_FILTER,
  isNativeBuildEntryName,
  isSharedNativePackage,
  isSharedPackageDir,
  isSourceBuildDir,
  loadedNativeBuildDir,
  nativeBuildEntryDir,
  nativeBuildEntryName,
  nodePtyBuildArtifactPaths,
  nodePtyNativeModuleName,
  resolveNativePackageDir
}
