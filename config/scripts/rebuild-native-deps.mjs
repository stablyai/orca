#!/usr/bin/env node
// Use @electron/rebuild API to skip optional ssh2 cpu-features: missing buildcheck.gypi/unsupported Electron V8 APIs can block install; ssh2 falls back to JS.
// electron-builder install-app-deps lacks ignoreModules (26.x); this script also serves beforeBuild.

import { rebuild } from '@electron/rebuild'
import {
  hasAdoptedSharedElectronDist,
  resolveSharedElectronDistEntry
} from './shared-electron-dist-cache.mjs'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  ensureWindowsProcessTreeCommandLinePatch,
  inspectWindowsProcessTreeAddon,
  stageWindowsProcessTreeNodeAddonApiHeaders,
  windowsProcessTreeAddonPath
} from './windows-process-tree-gyp-rebuild.mjs'
import { disableMsbuildFileTrackingOnWindows } from './msbuild-file-tracking.mjs'
import { warnAboutNodeModulesAboveSharedStore } from './store-ancestor-node-modules.mjs'
import {
  isSharedNativePackage,
  nodePtyBuildArtifactPaths,
  resolveNativePackageDir
} from './native-build-entry.cjs'
import {
  copyFileSync,
  existsSync,
  globSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { platform as osPlatform } from 'node:os'
import { join, resolve } from 'node:path'

const requireLocal = createRequire(import.meta.url)

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
// Resolve download target once so child installer and usability check agree on expected binary.
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
const NODE_PTY_CONPTY_RUNTIME_FILES = ['conpty.dll', 'OpenConsole.exe']

if (ignoreModules.length > 0) {
  console.log(`[rebuild] Skipping optional Electron rebuild modules: ${ignoreModules.join(', ')}`)
}

// Explicit onlyModules bypasses unreliable pnpm-store walker so every native module uses Electron’s Node ABI.
const NATIVE_MODULES = [
  'node-pty',
  'cpu-features',
  ...(rebuildPlatform === 'win32'
    ? ['@orca/windows-registry', '@orca/windows-security', '@vscode/windows-process-tree']
    : [])
]
const onlyModules = NATIVE_MODULES.filter((m) => !ignoreModules.includes(m))
// Global pnpm store shares packages across worktrees; publish per-ABI build beside build/Release instead of mutating it.
const sharedModules = new Set(onlyModules.filter((m) => isSharedNativePackage(m, projectDir)))
// Loaded only when needed, so a normal install runs exactly the code it always did.
const sharedNativeBuild = sharedModules.size > 0 ? await import('./shared-native-build.mjs') : null
/** Whether this rebuild targets something other than the machine running it. */
const isCrossHostRebuild = rebuildPlatform !== osPlatform() || rebuildArch !== process.arch
const forceRebuild =
  process.env.ORCA_FORCE_NATIVE_REBUILD === '1' || cliOptions.force || isCrossHostRebuild
let modulesToRebuild = onlyModules

warnAboutNodeModulesAboveSharedStore(projectDir)
ensureElectronPackageInstalled()
restoreNodePtyWindowsConptyRuntime()

const patchedNodePtyRebuildReason = forceRebuild ? null : getPatchedNodePtyRebuildReason()

if (patchedNodePtyRebuildReason) {
  console.log(`[rebuild] ${patchedNodePtyRebuildReason}`)
} else if (!forceRebuild) {
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

// Forced rebuild skips cpu-features install hook; regenerate missing buildcheck.gypi before node-gyp or fresh/pruned installs fail.
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
  // Keep stale-addon deletion inside lock-classifying try: running Orca can hold it and cause EPERM.
  assertNodePtyConptySourceDeniesMsysBreakaway()
  for (const moduleName of modulesToRebuild.filter((m) => sharedModules.has(m))) {
    buildSharedElectronModule(moduleName)
  }
  modulesToRebuild = modulesToRebuild.filter((m) => !sharedModules.has(m))
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
  disableMsbuildFileTrackingOnWindows()
  if (modulesToRebuild.length > 0) {
    await rebuild({
      buildPath: projectDir,
      electronVersion,
      platform: rebuildPlatform,
      arch: rebuildArch,
      ignoreModules,
      onlyModules: modulesToRebuild,
      // Force rebuild: already-built detection can accept system-Node ABI output incompatible with Electron.
      force: true
    })
  }
  restoreNodePtyWindowsConptyRuntime()
  assertWindowsProcessTreeAddonIsPatched()
  assertNodePtyConptyDeniesMsysBreakaway()
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

// Validate addon copied into packaged node_modules; runtime/relay gates inspect other artifacts. After successful rebuild, anything but clean (including missing) must fail.
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

// Inspect binary even if Electron probe is unavailable or target arch cannot execute. Same-host missing output falls back to unsafe prebuild and must fail; cross-host only warns.
function assertNodePtyConptyDeniesMsysBreakaway() {
  if (rebuildPlatform !== 'win32' || !modulesToRebuild.includes('node-pty')) {
    return
  }
  const { assertRebuiltConptyDeniesMsysBreakaway } = requireLocal('./node-pty-job-ownership.cjs')
  assertRebuiltConptyDeniesMsysBreakaway({
    nodePtyDir: resolve(projectDir, 'node_modules', 'node-pty'),
    rebuildArch,
    crossHost: isCrossHostRebuild
  })
}

// Check source before compiling: stale source cannot produce denial and repeating rebuild cannot help. Avoid touching locked addon during source check.
function assertNodePtyConptySourceDeniesMsysBreakaway() {
  if (rebuildPlatform !== 'win32' || !modulesToRebuild.includes('node-pty')) {
    return
  }
  const { assertNodePtySourceDeniesMsysBreakaway } = requireLocal('./node-pty-job-ownership.cjs')
  assertNodePtySourceDeniesMsysBreakaway({
    nodePtyDir: resolve(projectDir, 'node_modules', 'node-pty')
  })
}

function buildSharedElectronModule(moduleName) {
  const target = { platform: rebuildPlatform, arch: rebuildArch }
  // An N-API build serves Electron and Node alike, so either can vouch for it on this host.
  const executable = electronPackageIsUsable() ? getElectronExecutablePath() : process.execPath
  sharedNativeBuild.ensureSharedNativeBuild({
    moduleName,
    packageDir: resolveNativePackageDir(moduleName, projectDir),
    ...target,
    checkBuildDir: (dir) =>
      isCrossHostRebuild
        ? sharedNativeBuild.checkNativeBuildDirArtifacts(moduleName, dir, target)
        : sharedNativeBuild.checkNativeBuildDirLoads(moduleName, dir, { executable }),
    log: (message) => console.log(`[rebuild] ${message}`)
  })
}

function restoreNodePtyWindowsConptyRuntime() {
  // A shared node-pty's published build carries its own ConPTY runtime.
  if (
    rebuildPlatform !== 'win32' ||
    !onlyModules.includes('node-pty') ||
    sharedModules.has('node-pty')
  ) {
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
  repairElectronPathFile()
  if (electronPackageIsUsable()) {
    const shared = resolveSharedElectronDistEntry({
      repoRoot: projectDir,
      electronPackageDir,
      version: electronVersion,
      targetPlatform: electronInstallPlatform,
      targetArch: electronInstallArch
    })
    if (shared && !hasAdoptedSharedElectronDist(shared)) {
      runElectronPackageBinaryInstall()
    }
    return
  }

  // Inspect dist directly: CI postinstall can omit path.txt, and lazy Electron 42 require would run install.js before strict partial-extract checks.
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

function getPatchedNodePtyRebuildReason() {
  if (!requiresPatchedNodePtySourceBuild()) {
    return null
  }

  // Require patched native spawn/job ownership: loadable upstream prebuilds may lack Orca’s changes.
  const artifactPaths = nodePtyBuildArtifactPaths(
    resolve(projectDir, 'node_modules', 'node-pty'),
    rebuildPlatform
  )
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
const { resolve } = require('node:path')
const projectRequire = createRequire(resolve(process.cwd(), 'package.json'))
const { isSourceBuildDir, nodePtyNativeModuleName: getNodePtyNativeModuleName } = projectRequire(
  './config/scripts/native-build-entry.cjs'
)
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
  if (moduleName === '@orca/windows-registry') {
    const registry = projectRequire(moduleName)
    // Why: the package defers loading its .node addon until the first registry call.
    registry.getRegistryKey(registry.HK.CU, 'Environment')
    return
  }
  if (moduleName === '@orca/windows-security') {
    const security = projectRequire(moduleName)
    if (!security.currentUserSid() || !security.hasNativeExport('isolatedSpawnBreaksAwayFromJob')) throw new Error('stale build without the newest export; rebuild it')
    return
  }
  if (moduleName === 'node-pty') {
    projectRequire('node-pty')
    const { assertNodePtyJobOwnership, nodePtyAddonPath } = projectRequire(
      './config/scripts/node-pty-job-ownership.cjs'
    )
    const { loadNativeModule } = projectRequire('node-pty/lib/utils')
    const nativeName = getNodePtyNativeModuleName()
    const native = loadNativeModule(nativeName)
    const addonPath = nodePtyAddonPath(
      projectRequire.resolve('node-pty/lib/utils'),
      native,
      nativeName
    )
    assertNodePtyWindowsConptyRuntime(native.dir, require('node:path').dirname(addonPath))
    assertNodePtyJobOwnership({ nativeName, native, addonPath })
    if (requirePatchedNodePtySourceBuild && !isSourceBuildDir(native.dir)) {
      throw new Error(
        'node-pty resolved to ' +
          native.dir +
          '; expected build/Release so Orca\\'s node-pty patch is active'
      )
    }
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

function assertNodePtyWindowsConptyRuntime(nativeDir, loadedDir) {
  if (process.platform !== 'win32' || !isSourceBuildDir(nativeDir)) {
    return
  }
  const runtimeDir = resolve(loadedDir, 'conpty')
  for (const filename of ${JSON.stringify(NODE_PTY_CONPTY_RUNTIME_FILES)}) {
    const runtimeFile = resolve(runtimeDir, filename)
    if (!existsSync(runtimeFile)) {
      throw new Error('node-pty ConPTY runtime file is missing: ' + runtimeFile)
    }
  }
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
