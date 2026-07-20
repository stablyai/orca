#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { release } from 'node:os'
import { basename, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const scriptPath = import.meta.filename
const projectDir = resolve(import.meta.dirname, '../..')
const runtime = readRuntimeArg()

const NATIVE_MODULES = [
  'node-pty',
  ...(process.platform === 'win32' ? ['windows-native-registry'] : [])
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
  if (runtimeIndex >= 0) {
    return process.argv[runtimeIndex + 1]
  }

  return null
}

function ensureNodeRuntime() {
  const initial = runNodeCheck()
  const patchedNodePtyRebuildReason = getPatchedNodePtyRebuildReason()
  if (initial.ok && !patchedNodePtyRebuildReason) {
    return
  }

  if (patchedNodePtyRebuildReason) {
    console.warn(`[native-runtime] ${patchedNodePtyRebuildReason}`)
    if (!initial.ok) {
      printCheckError(initial)
    }
    runPnpm(['rebuild', 'node-pty'])
    verifyNodeRuntimeAfterRebuild()
    return
  }

  const failedModules = initial.failures.map((failure) => failure.moduleName)
  console.warn(
    `[native-runtime] ${formatRuntimeLabel('node')} cannot load native modules; rebuilding ${failedModules.join(', ')} for Node.`
  )
  printCheckError(initial)
  runPnpm(['rebuild', ...failedModules])
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
  // Why: a failed native addon load can poison the current process, so the
  // post-rebuild verification must happen in a fresh Node process.
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
  if (moduleName === 'windows-native-registry') {
    const registry = require(moduleName)
    // Why: the package defers loading its .node addon until the first registry call.
    registry.getRegistryKey(registry.HK.CU, 'Environment')
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
  const nativeName = getNodePtyNativeModuleName()
  // Why: node-pty's Windows JS wrapper defers conpty.node/pty.node until a
  // terminal is created, so require('node-pty') alone can miss ABI mismatches.
  const native = loadNativeModule(nativeName)
  assertNodePtyWindowsConptyRuntime(native?.dir)
  if (requiresPatchedNodePtySourceBuild() && !isNodePtyReleaseBuildDir(native?.dir)) {
    throw new Error(
      `node-pty resolved to ${native.dir}; expected build/Release so Orca's node-pty patch is active`
    )
  }
}

function assertNodePtyWindowsConptyRuntime(nativeDir) {
  if (process.platform !== 'win32' || !isNodePtyReleaseBuildDir(nativeDir)) {
    return
  }
  const runtimeDir = resolve(projectDir, 'node_modules', 'node-pty', 'build', 'Release', 'conpty')
  const missingFile = NODE_PTY_CONPTY_RUNTIME_FILES.find(
    (filename) => !existsSync(resolve(runtimeDir, filename))
  )
  if (missingFile) {
    throw new Error(`node-pty ConPTY runtime file is missing: ${resolve(runtimeDir, missingFile)}`)
  }
}

function getNodePtyNativeModuleName() {
  if (process.platform !== 'win32') {
    return 'pty'
  }

  return getWindowsBuildNumber() >= 18309 ? 'conpty' : 'pty'
}

function getPatchedNodePtyRebuildReason() {
  if (!requiresPatchedNodePtySourceBuild()) {
    return null
  }

  // Why: a loadable upstream node-pty prebuild is not enough; Orca's Unix
  // patch only lands in the source-built build/Release artifacts.
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

  return 'Patched node-pty build artifacts are missing; rebuilding native deps.'
}

function requiresPatchedNodePtySourceBuild() {
  if (process.platform === 'win32') {
    return false
  }

  const nodePtyPatchPath = resolve(projectDir, 'config', 'patches', 'node-pty@1.1.0.patch')
  if (!existsSync(nodePtyPatchPath)) {
    return false
  }

  return existsSync(resolve(projectDir, 'node_modules', 'node-pty'))
}

function isNodePtyReleaseBuildDir(nativeDir) {
  return typeof nativeDir === 'string' && nativeDir.replace(/\\/g, '/').includes('build/Release/')
}

function getWindowsBuildNumber() {
  const match = /(\d+)\.(\d+)\.(\d+)/g.exec(release())
  return match && match.length === 4 ? Number.parseInt(match[3], 10) : 0
}

function runPnpm(args) {
  const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  const result = spawnSync(command, args, {
    cwd: projectDir,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  })

  if (result.error || result.status !== 0) {
    console.error(`[native-runtime] ${command} ${args.join(' ')} failed.`)
    if (result.error) {
      console.error(formatError(result.error))
    }
    process.exit(result.status ?? 1)
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
