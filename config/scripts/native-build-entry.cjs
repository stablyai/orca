'use strict'

const { existsSync, realpathSync } = require('node:fs')
const { release } = require('node:os')
const { join, relative, isAbsolute } = require('node:path')

// Global pnpm store shares physical packages across worktrees; in-place build/Release rebuild can replace another running app’s binary.
// Publish immutable build/<entry> per ABI atomically; patched node-pty/windows-process-tree loaders must compute same names (parity test).

const ENTRY_PREFIX = 'orca-'

const NATIVE_BUILD_PACKAGES = {
  // Both use N-API: same platform/arch binary loads in Node and Electron.
  'node-pty': { abi: 'napi' },
  '@vscode/windows-process-tree': { abi: 'napi' }
}

// Key N-API by platform/arch; other addons need NODE_MODULE_VERSION, differing between Node/Electron majors.
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

function loadedNativeBuildDir(packageDir, moduleName, target) {
  const entryDir = nativeBuildEntryDir(packageDir, moduleName, target)
  return existsSync(entryDir) ? entryDir : join(packageDir, 'build', 'Release')
}

// Match node-pty: ConPTY from Windows build 18309, winpty earlier.
function nodePtyNativeModuleName(platform = process.platform, osRelease = release()) {
  if (platform !== 'win32') {
    return 'pty'
  }
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(osRelease)
  return match && Number.parseInt(match[3], 10) >= 18309 ? 'conpty' : 'pty'
}

function isNativeBuildEntryName(name) {
  return name.startsWith(ENTRY_PREFIX)
}

const TRANSIENT_NATIVE_BUILD_ENTRY_FILTER = [`!build/${ENTRY_PREFIX}*.{staging,unusable}-*{,/**/*}`]

// Resolve physical package path to detect shared store; node_modules link itself appears project-local.
function isSharedPackageDir(packageDir, projectDir) {
  try {
    const rel = relative(realpathSync(projectDir), realpathSync(packageDir))
    return rel.startsWith('..') || isAbsolute(rel)
  } catch {
    return false
  }
}

function isSharedNativePackage(moduleName, projectDir) {
  if (!NATIVE_BUILD_PACKAGES[moduleName]) {
    return false
  }
  try {
    return isSharedPackageDir(resolveNativePackageDir(moduleName, projectDir), projectDir)
  } catch {
    return false
  }
}

function resolveNativePackageDir(moduleName, projectDir) {
  const packageDir = join(projectDir, 'node_modules', ...moduleName.split('/'))
  if (!existsSync(join(packageDir, 'package.json'))) {
    throw new Error(`${moduleName} is not installed in ${projectDir}`)
  }
  return packageDir
}

function nodePtyBuildArtifactPaths(nodePtyDir, platform = process.platform) {
  const buildDir = loadedNativeBuildDir(nodePtyDir, 'node-pty')
  if (platform === 'win32') {
    return ['conpty.node', 'conpty/conpty.dll', 'conpty/OpenConsole.exe'].map((file) =>
      join(buildDir, file)
    )
  }
  // macOS builds spawn-helper; Linux builds only pty.node.
  return ['pty.node', ...(platform === 'darwin' ? ['spawn-helper'] : [])].map((file) =>
    join(buildDir, file)
  )
}

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
