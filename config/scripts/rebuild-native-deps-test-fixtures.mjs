import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
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

export function writeFakeElectronRebuild(projectDir, { logPathEnv = null } = {}) {
  const rebuildDir = join(projectDir, 'node_modules', '@electron', 'rebuild')
  mkdirSync(rebuildDir, { recursive: true })
  writeFileSync(join(rebuildDir, 'package.json'), JSON.stringify({ type: 'module' }))
  writeFileSync(
    join(rebuildDir, 'index.js'),
    logPathEnv
      ? `
import { appendFileSync } from 'node:fs'

export async function rebuild(options) {
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
      : 'export async function rebuild() {}\n'
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

export function writeFakeWindowsProcessTreeWithNodeAddonApi(projectDir) {
  const processTreeDir = join(projectDir, 'node_modules', '@vscode', 'windows-process-tree')
  const nodeAddonApiDir = join(processTreeDir, 'node_modules', 'node-addon-api')
  mkdirSync(nodeAddonApiDir, { recursive: true })
  writeFileSync(join(processTreeDir, 'package.json'), '{"dependencies":{"node-addon-api":"*"}}\n')
  writeFileSync(join(processTreeDir, 'index.js'), 'module.exports = {}\n')
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
