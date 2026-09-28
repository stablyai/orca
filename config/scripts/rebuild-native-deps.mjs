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
import { spawnSync } from 'node:child_process'
import {
  ensureWindowsProcessTreeCommandLinePatch,
  inspectWindowsProcessTreeAddon,
  stageWindowsProcessTreeNodeAddonApiHeaders,
  windowsProcessTreeAddonPath
} from './windows-process-tree-gyp-rebuild.mjs'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
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
// Why: resolve the Electron download target once so the child installer and the
// usability check can never disagree about which binary should be on disk.
const electronInstallPlatform =
  cliOptions.platform ||
  process.env.ELECTRON_INSTALL_PLATFORM ||
  process.env.npm_config_platform ||
  rebuildPlatform
const electronInstallArch =
  cliOptions.arch || process.env.ELECTRON_INSTALL_ARCH || process.env.npm_config_arch || rebuildArch
const electronPackageDir = resolve(projectDir, 'node_modules/electron')
const electronVersion = JSON.parse(
  readFileSync(resolve(electronPackageDir, 'package.json'), 'utf8')
).version

const ignoreModules = ['cpu-features']

if (ignoreModules.length > 0) {
  console.log(`[rebuild] Skipping optional Electron rebuild modules: ${ignoreModules.join(', ')}`)
}

// Why: @electron/rebuild's default module walker doesn't reliably find native
// modules inside pnpm's .pnpm/ store. Passing an explicit list of modules to
// rebuild via `onlyModules` ensures they're recompiled against Electron's Node
// ABI regardless of the package manager's store layout.
const NATIVE_MODULES = [
  'cpu-features',
  ...(rebuildPlatform === 'win32' ? ['@orca/windows-registry', '@vscode/windows-process-tree'] : [])
]
const onlyModules = NATIVE_MODULES.filter((m) => !ignoreModules.includes(m))
/** Whether this rebuild targets something other than the machine running it. */
const isCrossHostRebuild = rebuildPlatform !== osPlatform() || rebuildArch !== process.arch
const forceRebuild =
  process.env.ORCA_FORCE_NATIVE_REBUILD === '1' || cliOptions.force || isCrossHostRebuild
let modulesToRebuild = onlyModules

ensureElectronPackageInstalled()

// An empty allowlist invokes @electron/rebuild's default scanner.
if (onlyModules.length === 0) {
  console.log('[rebuild] No native modules selected; Electron package is ready.')
  process.exit(0)
}

if (!forceRebuild) {
  // Why: independent probes avoid rebuilding healthy Windows DLLs that may already be loaded and locked.
  const probes = onlyModules.map((moduleName) => ({
    moduleName,
    result: probeElectronNativeModules([moduleName])
  }))
  modulesToRebuild = probes.filter(({ result }) => !result.ok).map(({ moduleName }) => moduleName)
  if (modulesToRebuild.length === 0) {
    console.log('[rebuild] Native modules already load in Electron; skipping rebuild.')
    process.exit(0)
  }
  console.log(`[rebuild] Rebuilding failed native modules: ${modulesToRebuild.join(', ')}`)
  for (const { result } of probes) {
    if (!result.ok && result.stderr.trim()) {
      console.log(result.stderr.trim())
    }
  }
} else {
  console.log(`[rebuild] Forcing native rebuild for ${rebuildPlatform}-${rebuildArch}.`)
}

try {
  // Why inside the try: the patch guard deletes a stale addon binary, and that
  // delete fails EPERM when the addon is loaded -- exactly the running-Orca case
  // the catch below is written for. Outside, it aborted `pnpm install` with a
  // raw stack instead of the "close running Orca/Electron processes" message.
  if (
    rebuildPlatform === 'win32' &&
    modulesToRebuild.includes('@vscode/windows-process-tree') &&
    existsSync(join(projectDir, 'node_modules', '@vscode', 'windows-process-tree', 'package.json'))
  ) {
    stageWindowsProcessTreeNodeAddonApiHeaders()
    if (ensureWindowsProcessTreeCommandLinePatch()) {
      console.warn('[rebuild] Repaired the un-applied windows-process-tree command-line patch.')
    }
  }
  await rebuild({
    buildPath: projectDir,
    electronVersion,
    platform: rebuildPlatform,
    arch: rebuildArch,
    ignoreModules,
    onlyModules: modulesToRebuild,
    // Why: without force, @electron/rebuild skips modules it considers
    // "already built" — even when they were compiled for the wrong ABI
    // (e.g., system Node instead of Electron's embedded Node). This is
    // common after pnpm install, which compiles native modules for system
    // Node before postinstall runs this script.
    force: true
  })
  assertWindowsProcessTreeAddonIsPatched()
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

/**
 * The binary this rebuild just produced is the one the packaged app ships.
 *
 * The relay build asserts its own artifact and `ensure-native-runtime.mjs`
 * asserts what it loads, but nothing checked the addon that gets copied into the
 * packaged `node_modules` -- so a rebuild that silently produced the upstream
 * reader would reach users. Anything but `clean` fails: after a rebuild that
 * reported success the binary must exist, so `missing` is a broken build, not an
 * absence to shrug at. This is the caller that needs the state to be a state and
 * not a boolean.
 */
function assertWindowsProcessTreeAddonIsPatched() {
  if (
    rebuildPlatform !== 'win32' ||
    !modulesToRebuild.includes('@vscode/windows-process-tree') ||
    !existsSync(join(projectDir, 'node_modules', '@vscode', 'windows-process-tree', 'package.json'))
  ) {
    return
  }
  const addonPath = windowsProcessTreeAddonPath()
  const state = inspectWindowsProcessTreeAddon(addonPath)
  if (state === 'clean') {
    return
  }
  throw new Error(
    state === 'missing'
      ? `the rebuild reported success but ${addonPath} is not there, so the packaged app would ` +
          'ship no windows-process-tree addon at all.'
      : `${addonPath} still imports ReadProcessMemory, so it was not built from the patched ` +
          'command-line reader. The packaged app would carry the primitive MDE scores as ' +
          'credential dumping.'
  )
}

function ensureElectronPackageInstalled() {
  repairElectronPathFile()
  if (electronPackageIsUsable()) {
    return
  }

  // Why: CI has observed Electron's postinstall exiting cleanly without
  // writing path.txt. Electron 42's lazy require() would run install.js here,
  // so inspect dist/ directly and keep using our strict partial-extract checks.
  console.log('[rebuild] Electron package binary is missing; installing Electron package binary.')
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

  repairElectronPathFile()
  if (!electronPackageIsUsable()) {
    logElectronInstallDiagnostics()
    if (continuePostinstallWithoutElectron()) {
      process.exit(0)
    }
    console.error('[rebuild] Electron package is still unavailable after retry.')
    process.exit(1)
  }
}

function electronPackageIsUsable() {
  try {
    const installedPlatformPath = readFileSync(resolve(electronPackageDir, 'path.txt'), 'utf8')
    return (
      electronDistMatchesPackage(getElectronExecutablePath()) &&
      installedPlatformPath === getElectronPlatformPath()
    )
  } catch {
    return false
  }
}

function electronDistMatchesPackage(electronExecutable) {
  try {
    const installedVersion = readFileSync(resolve(electronPackageDir, 'dist', 'version'), 'utf8')
      .trim()
      .replace(/^v/, '')
    return installedVersion === electronVersion && existsSync(electronExecutable)
  } catch {
    return false
  }
}

function runElectronPackageBinaryInstall() {
  const env = {
    ...process.env,
    ELECTRON_INSTALL_PLATFORM: electronInstallPlatform,
    ELECTRON_INSTALL_ARCH: electronInstallArch
  }
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
  const electronExecutable = resolve(electronPackageDir, 'dist', platformPath)
  if (!electronDistMatchesPackage(electronExecutable)) {
    return
  }

  const pathFile = resolve(electronPackageDir, 'path.txt')
  let currentPath = ''
  try {
    currentPath = readFileSync(pathFile, 'utf8')
  } catch {
    // Missing path.txt is the common CI failure this script repairs.
  }
  if (currentPath !== platformPath) {
    writeFileSync(pathFile, platformPath)
    console.log(`[rebuild] Repaired Electron path.txt -> ${platformPath}`)
  }
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
  switch (electronInstallPlatform) {
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
      throw new Error(`Electron builds are not available on platform: ${electronInstallPlatform}`)
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

function probeElectronNativeModules(moduleNames) {
  if (!electronPackageIsUsable()) {
    return { ok: false, status: null, stderr: 'Electron package binary is unavailable.' }
  }
  const electronExecutable = getElectronExecutablePath()

  const probeSource = `
const { createRequire } = require('node:module')
const { resolve } = require('node:path')
const projectRequire = createRequire(resolve(process.cwd(), 'package.json'))
const moduleNames = ${JSON.stringify(moduleNames)}
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
  if (moduleName === '@orca/windows-registry') {
    const registry = projectRequire(moduleName)
    // Why: the package defers loading its .node addon until the first registry call.
    registry.getRegistryKey(registry.HK.CU, 'Environment')
    return
  }
  if (moduleName === '@vscode/windows-process-tree') {
    // The tarball prebuilt loads under Electron too -- the addon is N-API, so
    // a bare require proves nothing about which source it was built from.
    const { assertWindowsProcessTreeCreationTime } = projectRequire(
      './config/scripts/windows-process-tree-creation-time.cjs'
    )
    assertWindowsProcessTreeCreationTime({ module: projectRequire(moduleName) })
    return
  }
  projectRequire(moduleName)
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
  return /(?:EPERM|operation not permitted)[\s\S]*(?:unlink|\.node)/i.test(text)
}

function isPostinstall() {
  return process.env.npm_lifecycle_event === 'postinstall'
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error)
}
