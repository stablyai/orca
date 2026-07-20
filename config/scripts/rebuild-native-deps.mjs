#!/usr/bin/env node
/**
 * Why this script exists:
 *
 * The standard `electron-builder install-app-deps` uses @electron/rebuild
 * internally but does not expose the `ignoreModules` option (as of
 * electron-builder 26.x).  `cpu-features@0.0.10` is an optional performance
 * dependency of `ssh2`; it fails to build in common environments (missing
 * buildcheck.gypi on Windows, and Electron 42's V8 external-pointer API on
 * Linux).  This can make the entire postinstall step fail and prevent
 * `pnpm install` from completing.
 *
 * This script replaces `electron-builder install-app-deps` in the postinstall
 * lifecycle and the electron-builder beforeBuild hook. It calls
 * @electron/rebuild's JS API directly so that we can skip `cpu-features` when
 * rebuilding modules against Electron. Skipping
 * cpu-features is safe: ssh2 detects the missing native module and falls back
 * to pure-JS CPU feature detection automatically.
 */

import { rebuild } from '@electron/rebuild'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  globSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { platform as osPlatform } from 'node:os'
import { join, resolve } from 'node:path'

const projectDir = process.cwd()
let cliOptions
try {
  cliOptions = readCliOptions(process.argv.slice(2))
} catch (error) {
  console.error(`[rebuild] ${formatError(error)}`)
  process.exit(2)
}
const rebuildPlatform = cliOptions.platform ?? osPlatform()
const rebuildArch = cliOptions.arch ?? process.arch
const electronPackageDir = resolve(projectDir, 'node_modules/electron')
const electronVersion = JSON.parse(
  readFileSync(resolve(electronPackageDir, 'package.json'), 'utf8')
).version

const ignoreModules = ['cpu-features']
const NODE_PTY_CONPTY_RUNTIME_FILES = ['conpty.dll', 'OpenConsole.exe']

if (ignoreModules.length > 0) {
  console.log(`[rebuild] Skipping optional Electron rebuild modules: ${ignoreModules.join(', ')}`)
}

// Why: @electron/rebuild's default module walker doesn't reliably find native
// modules inside pnpm's .pnpm/ store. Passing an explicit list of modules to
// rebuild via `onlyModules` ensures they're recompiled against Electron's Node
// ABI regardless of the package manager's store layout.
const NATIVE_MODULES = [
  'node-pty',
  'cpu-features',
  ...(rebuildPlatform === 'win32' ? ['windows-native-registry'] : [])
]
const onlyModules = NATIVE_MODULES.filter((m) => !ignoreModules.includes(m))
const forceRebuild =
  process.env.ORCA_FORCE_NATIVE_REBUILD === '1' ||
  cliOptions.force ||
  rebuildPlatform !== osPlatform() ||
  rebuildArch !== process.arch

ensureElectronPackageInstalled()
restoreNodePtyWindowsConptyRuntime()

const patchedNodePtyRebuildReason = forceRebuild ? null : getPatchedNodePtyRebuildReason()

if (patchedNodePtyRebuildReason) {
  console.log(`[rebuild] ${patchedNodePtyRebuildReason}`)
} else if (!forceRebuild) {
  // Why: Windows cannot unlink a loaded .node DLL, so avoid @electron/rebuild
  // when the current install already works with Electron's ABI.
  const probe = probeElectronNativeModules(onlyModules)
  if (probe.ok) {
    console.log('[rebuild] Native modules already load in Electron; skipping rebuild.')
    process.exit(0)
  }
  console.log('[rebuild] Native modules do not load in Electron; rebuilding.')
  if (probe.stderr.trim()) {
    console.log(probe.stderr.trim())
  }
} else {
  console.log(`[rebuild] Forcing native rebuild for ${rebuildPlatform}-${rebuildArch}.`)
}

// Why: cpu-features ships without `buildcheck.gypi`; its own `install` script
// generates it by running `node buildcheck.js > buildcheck.gypi` before
// node-gyp. @electron/rebuild with `force: true` invokes node-gyp directly
// and bypasses that install hook, so if the file is missing (fresh install,
// store prune, or a prior failed run) node-gyp aborts with
// "buildcheck.gypi not found". Regenerate it here before rebuilding.
if (!ignoreModules.includes('cpu-features')) {
  const cpuFeatureDirs = globSync('node_modules/.pnpm/cpu-features@*/node_modules/cpu-features', {
    cwd: projectDir
  })
  for (const relDir of cpuFeatureDirs) {
    const dir = resolve(projectDir, relDir)
    const gypiPath = resolve(dir, 'buildcheck.gypi')
    if (existsSync(gypiPath)) {
      continue
    }
    try {
      const out = execFileSync(process.execPath, ['buildcheck.js'], {
        cwd: dir,
        encoding: 'utf8'
      })
      writeFileSync(gypiPath, out)
      console.log(`[rebuild] Generated ${relDir}/buildcheck.gypi`)
    } catch (/** @type {any} */ err) {
      console.error(`[rebuild] Failed to generate ${relDir}/buildcheck.gypi:`, err?.message ?? err)
      process.exit(1)
    }
  }
}

try {
  await rebuild({
    buildPath: projectDir,
    electronVersion,
    platform: rebuildPlatform,
    arch: rebuildArch,
    ignoreModules,
    onlyModules,
    // Why: without force, @electron/rebuild skips modules it considers
    // "already built" — even when they were compiled for the wrong ABI
    // (e.g., system Node instead of Electron's embedded Node). This is
    // common after pnpm install, which compiles native modules for system
    // Node before postinstall runs this script.
    force: true
  })
  restoreNodePtyWindowsConptyRuntime()
} catch (/** @type {any} */ err) {
  console.error('[rebuild] Native module rebuild failed:', err?.message ?? err)
  if (isWindowsNativeLockError(err)) {
    console.error(
      '[rebuild] A Windows process appears to be using a native .node file. ' +
        'Close running Orca/Electron/dev processes for this worktree, then rerun `pnpm install` ' +
        'or `pnpm run rebuild:electron`.'
    )
    if (isPostinstall() && process.env.ORCA_STRICT_NATIVE_REBUILD !== '1') {
      console.error(
        '[rebuild] Continuing postinstall because the failure is a Windows file lock. ' +
          'The next dev/start command will re-check native modules.'
      )
      process.exit(0)
    }
  }
  process.exit(1)
}

function restoreNodePtyWindowsConptyRuntime() {
  if (rebuildPlatform !== 'win32' || !onlyModules.includes('node-pty')) {
    return
  }

  const nodePtyDir = resolve(projectDir, 'node_modules', 'node-pty')
  if (!existsSync(join(nodePtyDir, 'build', 'Release', 'conpty.node'))) {
    return
  }
  const conptyRoot = join(nodePtyDir, 'third_party', 'conpty')
  const sourceDir = readdirSync(conptyRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(conptyRoot, entry.name, `win10-${rebuildArch}`))
    .find((candidate) => existsSync(candidate))
  if (!sourceDir) {
    throw new Error(`node-pty has no ConPTY runtime payload for win10-${rebuildArch}`)
  }

  const runtimeDir = join(nodePtyDir, 'build', 'Release', 'conpty')
  mkdirSync(runtimeDir, { recursive: true })
  for (const filename of NODE_PTY_CONPTY_RUNTIME_FILES) {
    const sourceFile = join(sourceDir, filename)
    if (!existsSync(sourceFile)) {
      throw new Error(`node-pty is missing ${sourceFile}`)
    }
    copyFileSync(sourceFile, join(runtimeDir, filename))
  }
  // Why: @electron/rebuild bypasses node-pty's postinstall step that normally copies these DLLs.
  console.log(`[rebuild] Restored node-pty ConPTY runtime files for win10-${rebuildArch}.`)
}

function ensureElectronPackageInstalled() {
  if (electronPackageIsUsable()) {
    return
  }

  // Why: CI has observed Electron's postinstall exiting cleanly without
  // writing path.txt. Electron 42's lazy require() would run install.js here,
  // so inspect dist/ directly and keep using our strict partial-extract checks.
  console.log('[rebuild] Electron package binary is missing; installing Electron package binary.')
  resetPartialElectronInstall()
  try {
    runElectronPackageBinaryInstall()
  } catch (/** @type {any} */ err) {
    console.error('[rebuild] Electron install retry failed:', err?.message ?? err)
    logElectronInstallDiagnostics()
    if (continuePostinstallWithoutElectron()) {
      process.exit(0)
    }
    process.exit(1)
  }

  if (!electronPackageIsUsable()) {
    const repaired = repairElectronPathFile()
    if (!repaired || !electronPackageIsUsable()) {
      logElectronInstallDiagnostics()
      if (continuePostinstallWithoutElectron()) {
        process.exit(0)
      }
      console.error('[rebuild] Electron package is still unavailable after retry.')
      process.exit(1)
    }
  }
}

function electronPackageIsUsable() {
  try {
    const installedVersion = readFileSync(resolve(electronPackageDir, 'dist', 'version'), 'utf8')
      .trim()
      .replace(/^v/, '')
    const installedPlatformPath = readFileSync(resolve(electronPackageDir, 'path.txt'), 'utf8')
    return (
      installedVersion === electronVersion &&
      installedPlatformPath === getElectronPlatformPath() &&
      existsSync(getElectronExecutablePath())
    )
  } catch {
    return false
  }
}

function runElectronPackageBinaryInstall() {
  const env = { ...process.env }
  delete env.ELECTRON_SKIP_BINARY_DOWNLOAD
  delete env.npm_config_electron_skip_binary_download

  const result = spawnSync(
    process.execPath,
    ['config/scripts/install-electron-package-binary.mjs'],
    {
      cwd: projectDir,
      env,
      stdio: 'inherit'
    }
  )

  if (result.error) {
    throw result.error
  }
  if (result.status !== 0) {
    throw new Error(
      `config/scripts/install-electron-package-binary.mjs exited with status ${result.status}`
    )
  }
}

function resetPartialElectronInstall() {
  // Why: Electron's installer can leave a partial dist/ tree behind after
  // skipped or interrupted postinstall runs; retry from a clean target.
  rmSync(resolve(electronPackageDir, 'dist'), { recursive: true, force: true })
  rmSync(resolve(electronPackageDir, 'path.txt'), { force: true })
}

function continuePostinstallWithoutElectron() {
  if (!isPostinstall() || process.env.ORCA_STRICT_ELECTRON_INSTALL === '1') {
    return false
  }
  console.error(
    '[rebuild] Continuing postinstall because Electron binary installation failed. ' +
      'Electron-consuming package scripts and release jobs run ' +
      'config/scripts/ensure-native-runtime.mjs --runtime=electron before launching Electron.'
  )
  return true
}

function repairElectronPathFile() {
  const platformPath = getElectronPlatformPath()
  if (!existsSync(getElectronExecutablePath())) {
    return false
  }

  // Why: Electron's install script has exited successfully in CI after
  // extraction without leaving path.txt. The package main only needs this file
  // to point at the already-extracted executable.
  writeFileSync(resolve(electronPackageDir, 'path.txt'), platformPath)
  console.log(`[rebuild] Repaired Electron path.txt -> ${platformPath}`)
  return true
}

function logElectronInstallDiagnostics() {
  const electronDistDir = resolve(electronPackageDir, 'dist')
  const pathFile = resolve(electronPackageDir, 'path.txt')
  console.error('[rebuild] Electron install diagnostics:')
  console.error(`  packageDir=${electronPackageDir} exists=${existsSync(electronPackageDir)}`)
  console.error(`  distDir=${electronDistDir} exists=${existsSync(electronDistDir)}`)
  console.error(`  pathFile=${pathFile} exists=${existsSync(pathFile)}`)
  if (existsSync(electronDistDir)) {
    console.error(`  distEntries=${safeReaddir(electronDistDir).join(', ')}`)
  }
}

function safeReaddir(targetPath) {
  try {
    return readdirSync(targetPath).slice(0, 20)
  } catch {
    return []
  }
}

function getElectronPlatformPath() {
  const targetPlatform =
    process.env.ELECTRON_INSTALL_PLATFORM || process.env.npm_config_platform || rebuildPlatform
  switch (targetPlatform) {
    case 'mas':
    case 'darwin':
      return 'Electron.app/Contents/MacOS/Electron'
    case 'freebsd':
    case 'openbsd':
    case 'linux':
      return 'electron'
    case 'win32':
      return 'electron.exe'
    default:
      throw new Error(`Electron builds are not available on platform: ${targetPlatform}`)
  }
}

function readCliOptions(args) {
  const options = { force: false }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--force') {
      options.force = true
      continue
    }
    if (arg === '--platform') {
      options.platform = readRequiredArgValue(args, (index += 1), '--platform')
      continue
    }
    if (arg.startsWith('--platform=')) {
      options.platform = readInlineArgValue(arg, '--platform')
      continue
    }
    if (arg === '--arch') {
      options.arch = readRequiredArgValue(args, (index += 1), '--arch')
      continue
    }
    if (arg.startsWith('--arch=')) {
      options.arch = readInlineArgValue(arg, '--arch')
      continue
    }
    throw new Error(`Unknown argument: ${arg}`)
  }
  return options
}

function readRequiredArgValue(args, index, flag) {
  const value = args[index]
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for ${flag}`)
  }
  return value
}

function readInlineArgValue(arg, flag) {
  const value = arg.slice(`${flag}=`.length)
  if (!value) {
    throw new Error(`Missing value for ${flag}`)
  }
  return value
}

function getElectronExecutablePath() {
  const platformPath = getElectronPlatformPath()
  return process.env.ELECTRON_OVERRIDE_DIST_PATH
    ? resolve(process.env.ELECTRON_OVERRIDE_DIST_PATH, platformPath)
    : resolve(electronPackageDir, 'dist', platformPath)
}

function getPatchedNodePtyRebuildReason() {
  if (!requiresPatchedNodePtySourceBuild()) {
    return null
  }

  // Why: Orca patches node-pty's native Unix spawn path; upstream prebuilds can
  // load successfully in Electron while missing the patched fd/error handling.
  const nodePtyDir = resolve(projectDir, 'node_modules', 'node-pty')
  const artifactPaths = [resolve(nodePtyDir, 'build', 'Release', 'pty.node')]
  // Why: node-pty only builds spawn-helper on macOS; Linux builds only pty.node.
  if (process.platform === 'darwin') {
    artifactPaths.push(resolve(nodePtyDir, 'build', 'Release', 'spawn-helper'))
  }
  const missingArtifact = artifactPaths.find((artifactPath) => !existsSync(artifactPath))

  if (!missingArtifact) {
    return null
  }

  return 'Patched node-pty build artifacts are missing; rebuilding from source.'
}

function requiresPatchedNodePtySourceBuild() {
  if (!onlyModules.includes('node-pty')) {
    return false
  }
  if (rebuildPlatform === 'win32') {
    return false
  }
  if (rebuildPlatform !== osPlatform() || rebuildArch !== process.arch) {
    return false
  }

  const nodePtyPatchPath = resolve(projectDir, 'config', 'patches', 'node-pty@1.1.0.patch')
  if (!existsSync(nodePtyPatchPath)) {
    return false
  }

  return existsSync(resolve(projectDir, 'node_modules', 'node-pty'))
}

function probeElectronNativeModules(moduleNames) {
  if (!electronPackageIsUsable()) {
    return { ok: false, status: null, stderr: 'Electron package binary is unavailable.' }
  }
  const electronExecutable = getElectronExecutablePath()

  const probeSource = `
const { createRequire } = require('node:module')
const { existsSync } = require('node:fs')
const { release } = require('node:os')
const { resolve } = require('node:path')
const projectRequire = createRequire(resolve(process.cwd(), 'package.json'))
const moduleNames = ${JSON.stringify(moduleNames)}
const requirePatchedNodePtySourceBuild = ${JSON.stringify(requiresPatchedNodePtySourceBuild())}
const failures = []

for (const moduleName of moduleNames) {
  try {
    loadNativeModule(moduleName)
  } catch (error) {
    failures.push(moduleName + ': ' + formatError(error))
  }
}

if (failures.length > 0) {
  console.error(failures.join('\\n'))
  process.exit(1)
}

function loadNativeModule(moduleName) {
  if (moduleName === 'windows-native-registry') {
    const registry = projectRequire(moduleName)
    // Why: the package defers loading its .node addon until the first registry call.
    registry.getRegistryKey(registry.HK.CU, 'Environment')
    return
  }
  if (moduleName === 'node-pty') {
    projectRequire('node-pty')
    const { loadNativeModule } = projectRequire('node-pty/lib/utils')
    const native = loadNativeModule(getNodePtyNativeModuleName())
    assertNodePtyWindowsConptyRuntime(native.dir)
    if (requirePatchedNodePtySourceBuild && !isNodePtyReleaseBuildDir(native.dir)) {
      throw new Error(
        'node-pty resolved to ' +
          native.dir +
          '; expected build/Release so Orca\\'s node-pty patch is active'
      )
    }
    return
  }
  projectRequire(moduleName)
}

function assertNodePtyWindowsConptyRuntime(nativeDir) {
  if (process.platform !== 'win32' || !isNodePtyReleaseBuildDir(nativeDir)) {
    return
  }
  const runtimeDir = resolve(
    process.cwd(),
    'node_modules',
    'node-pty',
    'build',
    'Release',
    'conpty'
  )
  for (const filename of ${JSON.stringify(NODE_PTY_CONPTY_RUNTIME_FILES)}) {
    const runtimeFile = resolve(runtimeDir, filename)
    if (!existsSync(runtimeFile)) {
      throw new Error('node-pty ConPTY runtime file is missing: ' + runtimeFile)
    }
  }
}

function isNodePtyReleaseBuildDir(nativeDir) {
  return typeof nativeDir === 'string' && nativeDir.replace(/\\\\/g, '/').includes('build/Release/')
}

function getNodePtyNativeModuleName() {
  if (process.platform !== 'win32') {
    return 'pty'
  }
  const match = /(\\d+)\\.(\\d+)\\.(\\d+)/g.exec(release())
  const buildNumber = match && match.length === 4 ? Number.parseInt(match[3], 10) : 0
  return buildNumber >= 18309 ? 'conpty' : 'pty'
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error)
}
`

  const result = spawnSync(electronExecutable, ['-e', probeSource], {
    cwd: projectDir,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1'
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })

  return {
    ok: result.status === 0,
    status: result.status,
    stderr: [result.stderr, result.stdout, result.error ? formatError(result.error) : '']
      .filter(Boolean)
      .join('\n')
  }
}

function isWindowsNativeLockError(error) {
  if (process.platform !== 'win32') {
    return false
  }
  const text = [error?.message, error?.stack, error?.stdout, error?.stderr]
    .filter(Boolean)
    .join('\n')
  return /(?:EPERM|operation not permitted)[\s\S]*(?:unlink|\.node|conpty\.node|pty\.node)/i.test(
    text
  )
}

function isPostinstall() {
  return process.env.npm_lifecycle_event === 'postinstall'
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error)
}
