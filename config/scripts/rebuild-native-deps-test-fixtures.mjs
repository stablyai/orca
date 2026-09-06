import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { copyScriptWithLocalModules } from './script-module-dependencies.mjs'

const sourceScriptPath = fileURLToPath(new URL('./rebuild-native-deps.mjs', import.meta.url))
const sourceInstallScriptPath = fileURLToPath(
  new URL('./install-electron-package-binary.mjs', import.meta.url)
)
const sourceNodePtyJobOwnershipPath = fileURLToPath(
  new URL('./node-pty-job-ownership.cjs', import.meta.url)
)
const sourceWindowsProcessTreeGypRebuildPath = fileURLToPath(
  new URL('./windows-process-tree-gyp-rebuild.mjs', import.meta.url)
)
const sourceWindowsProcessTreePatchPath = fileURLToPath(
  new URL('../patches/@vscode__windows-process-tree@0.8.0.patch', import.meta.url)
)

/**
 * The command-line reader as it is *before* the patch, taken from the patch's
 * own pre-image so no upstream copy has to be vendored.
 *
 * Written back as **CRLF**, which is what `@vscode/windows-process-tree@0.8.0`
 * actually ships: all 67 pre-image lines of this file carried a CR before the
 * patch was normalized to LF. Rebuilding it with the patch's current newline
 * instead would make fixture and patch agree by construction, on any encoding —
 * which is exactly how a repair that cannot apply to the real package passed
 * this suite.
 */
function unpatchedWindowsProcessTreeCommandLineSource() {
  const lines = readFileSync(sourceWindowsProcessTreePatchPath, 'utf8').split('\n')
  const start = lines.findIndex((line) =>
    line.startsWith('diff --git a/src/process_commandline.cc ')
  )
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => line.startsWith('diff --git '))
  const preImage = (end === -1 ? rest : rest.slice(0, end))
    .filter((line) => line.startsWith(' ') || line.startsWith('-'))
    .filter((line) => !line.startsWith('---'))
    .map((line) => line.slice(1).replace(/\r$/, ''))
    .join('\r\n')
  // Splitting drops the file's own trailing newline as an empty element, and
  // `git apply` needs the bytes exact.
  return `${preImage}\r\n`
}

/**
 * Pin `core.autocrlf` for a spawned repair, whatever the host is set to.
 *
 * The repair blinds git to the surrounding repo with `GIT_DIR`, so the value it
 * sees comes from global/system config — on a Git for Windows box that is
 * whichever line-ending option the installer wrote, and `false` (Git's built-in
 * default, "checkout as-is") is the one the repair used to fail under. A global
 * config in a temp HOME outranks the system file, so this is deterministic
 * rather than whatever the developer happens to have.
 */
export function gitLineEndingEnv(autocrlf) {
  const home = mkdtempSync(join(tmpdir(), `orca-git-home-${autocrlf}-`))
  writeFileSync(join(home, '.gitconfig'), `[core]\n\tautocrlf = ${autocrlf}\n`)
  return { HOME: home, USERPROFILE: home }
}

/** Production always runs the repair from inside a work tree; `git apply` behaves differently there. */
export function initGitWorkTree(projectDir) {
  for (const args of [['init'], ['config', 'user.email', 'a@b.c'], ['config', 'user.name', 't']]) {
    spawnSync('git', args, { cwd: projectDir, encoding: 'utf8' })
  }
}

export function writeWindowsProcessTreePatchFile(projectDir) {
  mkdirSync(join(projectDir, 'config', 'patches'), { recursive: true })
  copyFileSync(
    sourceWindowsProcessTreePatchPath,
    join(projectDir, 'config', 'patches', '@vscode__windows-process-tree@0.8.0.patch')
  )
}

export function mkTempProject() {
  const projectDir = mkdtempSync(join(tmpdir(), 'orca-rebuild-native-deps-'))
  mkdirSync(join(projectDir, 'config', 'scripts'), { recursive: true })
  copyFileSync(sourceScriptPath, join(projectDir, 'config', 'scripts', 'rebuild-native-deps.mjs'))
  copyScriptWithLocalModules(sourceInstallScriptPath, join(projectDir, 'config', 'scripts'))
  copyFileSync(
    sourceNodePtyJobOwnershipPath,
    join(projectDir, 'config', 'scripts', 'node-pty-job-ownership.cjs')
  )
  copyFileSync(
    sourceWindowsProcessTreeGypRebuildPath,
    join(projectDir, 'config', 'scripts', 'windows-process-tree-gyp-rebuild.mjs')
  )
  return projectDir
}

export function runRebuildScript(projectDir, extraEnv = {}, args = []) {
  const env = {
    ...process.env,
    npm_config_platform: 'linux',
    npm_config_arch: 'x64',
    ORCA_ELECTRON_PACKAGE_EXTRACTOR: join(projectDir, 'fake-extractor.cjs')
  }
  for (const key of Object.keys(env)) {
    if (
      key.toLowerCase() === 'orca_strict_electron_install' ||
      key.toLowerCase() === 'npm_lifecycle_event'
    ) {
      delete env[key]
    }
  }
  return spawnSync(process.execPath, ['config/scripts/rebuild-native-deps.mjs', ...args], {
    cwd: projectDir,
    encoding: 'utf8',
    env: {
      ...env,
      ...extraEnv
    }
  })
}

export function writeFakeElectronPackage(projectDir) {
  const electronDir = join(projectDir, 'node_modules', 'electron')
  mkdirSync(electronDir, { recursive: true })
  writeFileSync(
    join(electronDir, 'package.json'),
    JSON.stringify({ name: 'electron', version: '41.5.0' })
  )
  writeFileSync(join(electronDir, 'checksums.json'), '{}')
  writeFileSync(
    join(electronDir, 'index.js'),
    `
const fs = require('node:fs')
const path = require('node:path')
const pathFile = path.join(__dirname, 'path.txt')
if (!fs.existsSync(pathFile)) {
  throw new Error('Electron failed to install correctly, please delete node_modules/electron and try installing again')
}
const electronPath = path.join(__dirname, 'dist', fs.readFileSync(pathFile, 'utf8'))
if (!fs.existsSync(electronPath)) {
  throw new Error('Electron failed to install correctly, please delete node_modules/electron and try installing again')
}
module.exports = electronPath
`
  )
}

export function writeFakeElectronGet(
  projectDir,
  {
    downloadRejects = false,
    logPartialStateBeforeInstall = false,
    logTargetBeforeInstall = false
  } = {}
) {
  const getDir = join(projectDir, 'node_modules', 'electron', 'node_modules', '@electron', 'get')
  mkdirSync(getDir, { recursive: true })
  writeFileSync(
    join(getDir, 'index.js'),
    `
const { appendFileSync, existsSync, mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
exports.downloadArtifact = async function downloadArtifact(details) {
  if (${JSON.stringify(logTargetBeforeInstall)}) {
    appendFileSync(
      'electron-get.log',
      'platform=' + details.platform + ' arch=' + details.arch + '\\n'
    )
  }
  if (${JSON.stringify(logPartialStateBeforeInstall)}) {
    appendFileSync(
      'electron-get.log',
      existsSync('node_modules/electron/dist') || existsSync('node_modules/electron/path.txt')
        ? 'partial still present\\n'
        : 'partial cleared\\n'
    )
  }
  appendFileSync('electron-get.log', 'download attempted\\n')
  if (${JSON.stringify(downloadRejects)}) {
    throw new Error('download failed')
  }
  mkdirSync(details.cacheRoot, { recursive: true })
  const artifactPath = join(details.cacheRoot, 'electron.zip')
  writeFileSync(artifactPath, 'fake zip')
  return artifactPath
}
`
  )
}

export function writeFakeElectronExtractor(projectDir, { createExecutable }) {
  writeFileSync(
    join(projectDir, 'fake-extractor.cjs'),
    `
const { mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const extractDir = process.argv[3]
mkdirSync(join(extractDir, 'locales'), { recursive: true })
if (${JSON.stringify(createExecutable)}) {
  writeFileSync(join(extractDir, 'electron'), '')
  writeFileSync(join(extractDir, 'electron.exe'), '')
  writeFileSync(join(extractDir, 'version'), 'v41.5.0')
}
`
  )
}

/** Bytes that stand in for a compiled addon's import table. */
const FAKE_ADDON_BYTES = {
  clean: 'MZ\0ntdll.dll\0NtQueryInformationProcess\0',
  unpatched: 'MZ\0KERNEL32.dll\0ReadProcessMemory\0'
}

/**
 * A rebuild that produces nothing leaves no addon to inspect, and the script now
 * asserts the binary it just built is a patched one. Emit a stand-in so the
 * fixture models a rebuild that actually succeeded. `addon` picks which kind,
 * because "produced the upstream reader" and "produced nothing" are both real
 * outcomes that assertion has to tell apart.
 */
export function writeFakeElectronRebuild(projectDir, { logPathEnv = null, addon = 'clean' } = {}) {
  const rebuildDir = join(projectDir, 'node_modules', '@electron', 'rebuild')
  mkdirSync(rebuildDir, { recursive: true })
  writeFileSync(join(rebuildDir, 'package.json'), JSON.stringify({ type: 'module' }))
  const emitAddon =
    addon === 'none'
      ? ''
      : `
  const packageDir = join('node_modules', '@vscode', 'windows-process-tree')
  if (existsSync(join(packageDir, 'package.json'))) {
    mkdirSync(join(packageDir, 'build', 'Release'), { recursive: true })
    writeFileSync(
      join(packageDir, 'build', 'Release', 'windows_process_tree.node'),
      ${JSON.stringify(FAKE_ADDON_BYTES[addon])}
    )
  }`
  const emitImports =
    addon === 'none'
      ? ''
      : "import { existsSync, mkdirSync, writeFileSync } from 'node:fs'\nimport { join } from 'node:path'\n"
  writeFileSync(
    join(rebuildDir, 'index.js'),
    logPathEnv
      ? `
import { appendFileSync } from 'node:fs'
${emitImports}
export async function rebuild(options) {${emitAddon}
  const logPath = process.env[${JSON.stringify(logPathEnv)}]
  if (!logPath) {
    return
  }
  appendFileSync(
    logPath,
    JSON.stringify({
      arch: options.arch,
      electronVersion: options.electronVersion,
      force: options.force,
      ignoreModules: options.ignoreModules,
      onlyModules: options.onlyModules,
      platform: options.platform
    }) + '\\n'
  )
}
`
      : `${emitImports}
export async function rebuild() {${emitAddon}
}
`
  )
}

export function writeFakeUsableElectronPackage(projectDir, { platform = 'linux' } = {}) {
  writeFakeElectronPackage(projectDir)
  const electronDir = join(projectDir, 'node_modules', 'electron')
  const platformExecutable = platform === 'win32' ? 'electron.exe' : 'electron'
  const electronPath = join(electronDir, 'dist', platformExecutable)
  mkdirSync(join(electronDir, 'dist'), { recursive: true })
  writeFileSync(join(electronDir, 'path.txt'), platformExecutable)
  writeFileSync(join(electronDir, 'dist', 'version'), 'v41.5.0')
  if (platform === 'win32') {
    copyFileSync(process.execPath, electronPath)
  } else {
    writeFileSync(
      electronPath,
      `#!/usr/bin/env node
const { spawnSync } = require('node:child_process')

const result = spawnSync(process.execPath, process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  stdio: 'inherit'
})

if (result.error) {
  console.error(result.error.message)
  process.exit(1)
}

process.exit(result.status ?? 0)
`
    )
    chmodSync(electronPath, 0o755)
  }
}

export function writeFakeNodePtyConptyPayload(projectDir, arch) {
  const releaseDir = join(projectDir, 'node_modules', 'node-pty', 'build', 'Release')
  mkdirSync(releaseDir, { recursive: true })
  writeFileSync(join(releaseDir, 'conpty.node'), 'native addon')
  const sourceDir = join(
    projectDir,
    'node_modules',
    'node-pty',
    'third_party',
    'conpty',
    '0.1.0',
    `win10-${arch}`
  )
  mkdirSync(sourceDir, { recursive: true })
  writeFileSync(join(sourceDir, 'conpty.dll'), `conpty.dll ${arch}`)
  writeFileSync(join(sourceDir, 'OpenConsole.exe'), `OpenConsole.exe ${arch}`)
}

export function writeFakeLoadableNodePty(
  projectDir,
  { nativeDir = 'prebuilds/pty', ownsPtyJob = true } = {}
) {
  const nodePtyDir = join(projectDir, 'node_modules', 'node-pty')
  mkdirSync(join(nodePtyDir, 'lib'), { recursive: true })
  writeFileSync(join(nodePtyDir, 'index.js'), 'module.exports = {}\n')
  writeFileSync(
    join(nodePtyDir, 'lib', 'utils.js'),
    `
exports.loadNativeModule = function loadNativeModule(nativeName) {
  return {
    dir: ${JSON.stringify(nativeDir)},
    module: {
      nativeName,
      ...(${JSON.stringify(ownsPtyJob)}
        ? {
            listJobProcessIds() {},
            terminateJob() {},
            assignCurrentProcessToJob() {}
          }
        : {})
    }
  }
}
`
  )
}

export function writeFakeWindowsRegistry(projectDir) {
  const registryDir = join(projectDir, 'node_modules', 'windows-native-registry')
  mkdirSync(registryDir, { recursive: true })
  writeFileSync(
    join(registryDir, 'index.js'),
    'exports.HK = { CU: 0x80000001 }; exports.getRegistryKey = () => ({})\n'
  )
}

export function writeFakeWindowsProcessTree(projectDir) {
  const processTreeDir = join(projectDir, 'node_modules', '@vscode', 'windows-process-tree')
  mkdirSync(processTreeDir, { recursive: true })
  writeFileSync(join(processTreeDir, 'index.js'), 'module.exports = {}\n')
}

export function writeFakeWindowsProcessTreeWithNodeAddonApi(
  projectDir,
  { commandLinePatchApplied = true } = {}
) {
  const processTreeDir = join(projectDir, 'node_modules', '@vscode', 'windows-process-tree')
  const nodeAddonApiDir = join(processTreeDir, 'node_modules', 'node-addon-api')
  mkdirSync(nodeAddonApiDir, { recursive: true })
  writeFileSync(join(processTreeDir, 'package.json'), '{"dependencies":{"node-addon-api":"*"}}\n')
  writeFileSync(join(processTreeDir, 'index.js'), 'module.exports = {}\n')
  mkdirSync(join(processTreeDir, 'src'), { recursive: true })
  writeFileSync(
    join(processTreeDir, 'src', 'process_commandline.cc'),
    commandLinePatchApplied
      ? '// kProcessCommandLineInformation = 60\n'
      : unpatchedWindowsProcessTreeCommandLineSource()
  )
  writeFileSync(join(nodeAddonApiDir, 'package.json'), '{"name":"node-addon-api"}\n')
  writeFileSync(join(nodeAddonApiDir, 'napi.h'), '// napi.h\n')
  writeFileSync(join(nodeAddonApiDir, 'napi-inl.h'), '// napi-inl.h\n')
  writeFileSync(join(nodeAddonApiDir, 'napi-inl.deprecated.h'), '// napi-inl.deprecated.h\n')
}

export function writeNodePtyPatchFile(projectDir) {
  mkdirSync(join(projectDir, 'config', 'patches'), { recursive: true })
  writeFileSync(join(projectDir, 'config', 'patches', 'node-pty@1.1.0.patch'), 'patch marker\n')
}

export function writePatchedNodePtyBuildArtifacts(projectDir) {
  const buildDir = join(projectDir, 'node_modules', 'node-pty', 'build', 'Release')
  mkdirSync(buildDir, { recursive: true })
  if (process.platform === 'win32') {
    writeFileSync(join(buildDir, 'conpty.node'), '')
    mkdirSync(join(buildDir, 'conpty'), { recursive: true })
    writeFileSync(join(buildDir, 'conpty', 'conpty.dll'), '')
    writeFileSync(join(buildDir, 'conpty', 'OpenConsole.exe'), '')
    return
  }
  writeFileSync(join(buildDir, 'pty.node'), '')
  if (process.platform === 'darwin') {
    writeFileSync(join(buildDir, 'spawn-helper'), '')
  }
}
