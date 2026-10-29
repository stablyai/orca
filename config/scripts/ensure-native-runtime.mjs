#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import {
  ensureWindowsProcessTreeCommandLinePatch,
  inspectWindowsProcessTreeAddon,
  nodeGypRebuildInvocation,
  nodeGypRebuildTimeoutMs,
  stageWindowsProcessTreeNodeAddonApiHeaders,
  windowsProcessTreeAddonPath
} from './windows-process-tree-gyp-rebuild.mjs'
import { runProcessSync } from '@orca/process-host'
import { describeProcessFailure } from './process-failure-message.mjs'
import {
  isSharedNativePackage,
  isSourceBuildDir,
  nodePtyBuildArtifactPaths,
  nodePtyNativeModuleName,
  resolveNativePackageDir
} from './native-build-entry.cjs'
import {
  checkNativeBuildDirLoads,
  ensureSharedNativeBuild,
  nativeBuildEnvironment
} from './shared-native-build.mjs'

const require = createRequire(import.meta.url)
const { assertNodePtyJobOwnership, nodePtyAddonPath } = require('./node-pty-job-ownership.cjs')
const { assertWindowsProcessTreeCreationTime } = require('./windows-process-tree-creation-time.cjs')
const scriptPath = import.meta.filename
const projectDir = resolve(import.meta.dirname, '../..')
const runtime = readRuntimeArg()
// Why: `pnpm rebuild:node` must rebuild even a loadable node-pty; a shared slot still reuses its usable entry.
const forceRebuild = process.argv.includes('--force')

const NATIVE_MODULES = [
  'node-pty',
  ...(process.platform === 'win32'
    ? ['@orca/windows-registry', '@orca/windows-security', '@vscode/windows-process-tree']
    : [])
]
const NODE_PTY_CONPTY_RUNTIME_FILES = ['conpty.dll', 'OpenConsole.exe']
const CHILD_CHECK_FLAG = '--check-only'

if (process.argv.includes(CHILD_CHECK_FLAG)) {
  const failures = collectNativeModuleFailures()
  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`${failure.moduleName}: ${failure.message}`)
    }
    process.exit(1)
  }
  process.exit(0)
}

if (runtime === 'node') {
  ensureNodeRuntime()
} else if (runtime === 'electron') {
  ensureElectronRuntime()
} else {
  console.error('Usage: node config/scripts/ensure-native-runtime.mjs --runtime=node|electron')
  process.exit(2)
}

function readRuntimeArg() {
  const inline = process.argv.find((arg) => arg.startsWith('--runtime='))
  if (inline) {
    return inline.slice('--runtime='.length)
  }

  const runtimeIndex = process.argv.indexOf('--runtime')
  if (runtimeIndex !== -1) {
    return process.argv[runtimeIndex + 1]
  }

  return null
}

function ensureNodeRuntime() {
  const initial = runNodeCheck()
  const patchedNodePtyRebuildReason = getPatchedNodePtyRebuildReason()
  if (initial.ok && !patchedNodePtyRebuildReason && !forceRebuild) {
    return
  }

  if (patchedNodePtyRebuildReason || forceRebuild) {
    console.warn(
      `[native-runtime] ${patchedNodePtyRebuildReason ?? 'Forced rebuild of node-pty for Node.'}`
    )
    if (!initial.ok) {
      printCheckError(initial)
    }
    const failedModules = initial.failures.map((failure) => failure.moduleName)
    const rebuildModules = [
      'node-pty',
      ...failedModules.filter((moduleName) => moduleName !== 'node-pty')
    ]
    rebuildNodeRuntimeModules(rebuildModules)
    verifyNodeRuntimeAfterRebuild()
    return
  }

  const failedModules = initial.failures.map((failure) => failure.moduleName)
  console.warn(
    `[native-runtime] ${formatRuntimeLabel('node')} cannot load native modules; rebuilding ${failedModules.join(', ')} for Node.`
  )
  printCheckError(initial)
  rebuildNodeRuntimeModules(failedModules)
  verifyNodeRuntimeAfterRebuild()
}

function verifyNodeRuntimeAfterRebuild() {
  const final = runNodeCheck()
  if (!final.ok) {
    console.error(
      `[native-runtime] Native modules still do not load for ${formatRuntimeLabel('node')}.`
    )
    printCheckError(final)
    process.exit(1)
  }
}

function ensureElectronRuntime() {
  const initial = runElectronCheck()
  const patchedNodePtyRebuildReason = getPatchedNodePtyRebuildReason()
  if (initial.ok && !patchedNodePtyRebuildReason) {
    return
  }

  if (patchedNodePtyRebuildReason) {
    console.warn(`[native-runtime] ${patchedNodePtyRebuildReason}`)
    if (!initial.ok) {
      printCheckError(initial)
    }
  } else {
    console.warn(
      `[native-runtime] ${formatRuntimeLabel('electron')} cannot load native modules; rebuilding native deps for Electron.`
    )
    printCheckError(initial)
  }
  runNodeScript(['config/scripts/rebuild-native-deps.mjs'])

  const final = runElectronCheck()
  if (!final.ok) {
    console.error(
      `[native-runtime] Native modules still do not load for ${formatRuntimeLabel('electron')}.`
    )
    printCheckError(final)
    process.exit(1)
  }
}

function runNodeCheck() {
  // Failed addon loads can poison process state; verify rebuilt addons in a fresh Node process.
  const result = spawnSync(process.execPath, [scriptPath, CHILD_CHECK_FLAG], {
    cwd: projectDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })

  return parseChildCheckResult(result)
}

function runElectronCheck() {
  const electronExecutable = resolveInstalledElectronExecutable()
  if (!electronExecutable.ok) {
    return { ok: false, error: electronExecutable.error }
  }

  const result = spawnSync(electronExecutable.path, [scriptPath, CHILD_CHECK_FLAG], {
    cwd: projectDir,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1'
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })

  return parseChildCheckResult(result)
}

function resolveInstalledElectronExecutable() {
  const electronPackageDir = resolve(projectDir, 'node_modules/electron')
  try {
    const electronVersion = JSON.parse(
      readFileSync(resolve(electronPackageDir, 'package.json'), 'utf8')
    ).version
    const platformPath = getElectronPlatformPath()
    const installedVersion = readFileSync(resolve(electronPackageDir, 'dist', 'version'), 'utf8')
      .trim()
      .replace(/^v/, '')
    if (installedVersion !== electronVersion) {
      return {
        ok: false,
        error: new Error(
          `Electron package binary version ${installedVersion} does not match ${electronVersion}.`
        )
      }
    }
    const installedPlatformPath = readFileSync(resolve(electronPackageDir, 'path.txt'), 'utf8')
    if (installedPlatformPath !== platformPath) {
      return {
        ok: false,
        error: new Error(
          `Electron package path.txt points at ${installedPlatformPath}, expected ${platformPath}.`
        )
      }
    }
    const electronPath = process.env.ELECTRON_OVERRIDE_DIST_PATH
      ? resolve(process.env.ELECTRON_OVERRIDE_DIST_PATH, platformPath)
      : resolve(electronPackageDir, 'dist', platformPath)
    if (!existsSync(electronPath)) {
      return { ok: false, error: new Error(`Electron executable is missing at ${electronPath}.`) }
    }
    return { ok: true, path: electronPath }
  } catch (error) {
    return { ok: false, error }
  }
}

function getElectronPlatformPath() {
  const targetPlatform =
    process.env.ELECTRON_INSTALL_PLATFORM || process.env.npm_config_platform || process.platform
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

function parseChildCheckResult(result) {
  const failures = parseCheckFailures(result.stderr)

  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error,
    failures
  }
}

function parseCheckFailures(stderr) {
  const failures = []
  for (const line of (stderr ?? '').split(/\r?\n/)) {
    const match = /^([^:]+):\s*(.*)$/.exec(line)
    if (match && NATIVE_MODULES.includes(match[1])) {
      failures.push({ moduleName: match[1], message: match[2] })
    }
  }
  return failures
}

function collectNativeModuleFailures() {
  const failures = []
  for (const moduleName of NATIVE_MODULES) {
    try {
      loadNativeModule(moduleName)
    } catch (cause) {
      failures.push({ moduleName, message: formatError(cause), cause })
    }
  }
  return failures
}

function loadNativeModule(moduleName) {
  if (moduleName === '@vscode/windows-process-tree') {
    // Loadable node-addon-api prebuild can still read foreign command lines/ignore CreationTime; verify patched binary on both counts.
    assertWindowsProcessTreeCreationTime({ module: require(moduleName) })
    if (inspectWindowsProcessTreeAddon(windowsProcessTreeAddonPath()) === 'unpatched') {
      throw new Error(
        'the loaded addon still calls ReadProcessMemory, so it was not built from the patched ' +
          'source. Rebuild it (pnpm run rebuild:electron) rather than using the published prebuild.'
      )
    }
    return
  }
  if (moduleName === '@orca/windows-registry') {
    const registry = require(moduleName)
    // Why: the package defers loading its .node addon until the first registry call.
    registry.getRegistryKey(registry.HK.CU, 'Environment')
    return
  }
  if (moduleName === '@orca/windows-security') {
    // Why: the addon loads on first call; the newest export also rejects a stale build that loads.
    require(moduleName).clearStdHandleInheritance()
    return
  }
  if (moduleName === 'node-pty') {
    loadNodePtyNativeModule()
    return
  }

  require(moduleName)
}

function loadNodePtyNativeModule() {
  require('node-pty')

  const { loadNativeModule } = require('node-pty/lib/utils')
  const nativeName = nodePtyNativeModuleName()
  // Windows node-pty defers native loading until terminal creation; bare require misses ABI failures.
  const native = loadNativeModule(nativeName)
  const addonPath = nodePtyAddonPath(require.resolve('node-pty/lib/utils'), native, nativeName)
  assertNodePtyWindowsConptyRuntime(native?.dir, dirname(addonPath))
  assertNodePtyJobOwnership({ nativeName, native, addonPath })
  if (requiresPatchedNodePtySourceBuild() && !isSourceBuildDir(native?.dir)) {
    throw new Error(
      `node-pty resolved to ${native.dir}; expected build/Release so Orca's node-pty patch is active`
    )
  }
}

function assertNodePtyWindowsConptyRuntime(nativeDir, loadedDir) {
  if (process.platform !== 'win32' || !isSourceBuildDir(nativeDir)) {
    return
  }
  const runtimeDir = resolve(loadedDir, 'conpty')
  const missingFile = NODE_PTY_CONPTY_RUNTIME_FILES.find(
    (filename) => !existsSync(resolve(runtimeDir, filename))
  )
  if (missingFile) {
    throw new Error(`node-pty ConPTY runtime file is missing: ${resolve(runtimeDir, missingFile)}`)
  }
}

function getPatchedNodePtyRebuildReason() {
  if (!requiresPatchedNodePtySourceBuild()) {
    return null
  }

  // Loadable upstream prebuilds lack Orca patches; require source-built build/Release artifacts on both platforms.
  const nodePtyDir = resolve(projectDir, 'node_modules', 'node-pty')
  const artifactPaths = nodePtyBuildArtifactPaths(nodePtyDir)
  const missingArtifact = artifactPaths.find((artifactPath) => !existsSync(artifactPath))

  if (!missingArtifact) {
    return null
  }

  return 'Patched node-pty build artifacts are missing; rebuilding native deps.'
}

function requiresPatchedNodePtySourceBuild() {
  const nodePtyPatchPath = resolve(projectDir, 'config', 'patches', 'node-pty@1.1.0.patch')
  if (!existsSync(nodePtyPatchPath)) {
    return false
  }

  return existsSync(resolve(projectDir, 'node_modules', 'node-pty'))
}

function rebuildNodeRuntimeModules(moduleNames) {
  for (const moduleName of moduleNames) {
    let moduleDir = dirname(require.resolve(`${moduleName}/package.json`))
    if (isSharedNativePackage(moduleName, projectDir)) {
      // Why: other worktrees load this very dir, so build beside it instead of over it.
      buildSharedNodeRuntimeModule(moduleName, resolveNativePackageDir(moduleName, projectDir))
      continue
    }
    if (moduleName === '@vscode/windows-process-tree') {
      // Reapply process-tree patch before rebuild or pnpm’s unpatched source reproduces the defect; physical-dir node-gyp and node-addon-api setup live in windows-process-tree-gyp-rebuild.mjs.
      ensureWindowsProcessTreeCommandLinePatch(moduleDir)
      stageWindowsProcessTreeNodeAddonApiHeaders(moduleDir)
      moduleDir = realpathSync(moduleDir)
    }
    console.warn(`[native-runtime] Rebuilding ${moduleName} with node-gyp.`)
    // pnpm exec inside an installed addon cannot discover the root build tool.
    runNodeGyp(
      moduleName,
      nodeGypRebuildInvocation(
        process.arch,
        moduleDir,
        process.env.npm_config_node_gyp || undefined
      )
    )
    if (moduleName === 'node-pty' && process.platform === 'win32') {
      runNodeScript([resolve(moduleDir, 'scripts', 'post-install.js')])
    }
  }
}

function buildSharedNodeRuntimeModule(moduleName, packageDir) {
  try {
    ensureSharedNativeBuild({
      moduleName,
      packageDir,
      checkBuildDir: (dir) => checkNativeBuildDirLoads(moduleName, dir),
      nodeGypEntry: process.env.npm_config_node_gyp || undefined,
      log: (message) => console.warn(`[native-runtime] ${message}`)
    })
  } catch (error) {
    console.error(`[native-runtime] ${moduleName}: ${formatError(error)}`)
    process.exit(1)
  }
}

function runNodeGyp(moduleName, { args, cwd }) {
  const env = nativeBuildEnvironment()
  const result = runProcessSync({
    program: process.execPath,
    args,
    cwd,
    env,
    stdio: 'inherit',
    timeoutMs: nodeGypRebuildTimeoutMs(moduleName)
  })
  if (result.code !== 0) {
    console.error(
      `[native-runtime] node-gyp rebuild failed in ${cwd}: ${describeProcessFailure(result)}`
    )
    process.exit(result.code ?? 1)
  }
}

function runNodeScript(args) {
  const result = spawnSync(process.execPath, args, {
    cwd: projectDir,
    stdio: 'inherit'
  })

  if (result.error || result.status !== 0) {
    console.error(`[native-runtime] ${basename(process.execPath)} ${args.join(' ')} failed.`)
    if (result.error) {
      console.error(formatError(result.error))
    }
    process.exit(result.status ?? 1)
  }
}

function printCheckError(result) {
  for (const failure of result.failures ?? []) {
    console.warn(`[native-runtime] ${failure.moduleName}: ${failure.message}`)
  }
  if (result.error) {
    console.warn(`[native-runtime] ${formatError(result.error)}`)
  }
  if (result.stderr?.trim()) {
    console.warn(result.stderr.trim())
  }
  if (result.stdout?.trim()) {
    console.warn(result.stdout.trim())
  }
  if (
    result.status != null &&
    !result.error &&
    !result.stderr?.trim() &&
    !result.stdout?.trim() &&
    result.status !== 0
  ) {
    console.warn(`[native-runtime] Native check exited with status ${result.status}.`)
  }
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error)
}

function formatRuntimeLabel(value) {
  if (value === 'electron') {
    return `Electron ${process.env.npm_package_devDependencies_electron ?? ''}`.trim()
  }
  return `Node ${process.versions.node}`
}
