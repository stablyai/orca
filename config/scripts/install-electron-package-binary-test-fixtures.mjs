import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { copyScriptWithLocalModules } from './script-module-dependencies.mjs'

const sourceScriptPath = fileURLToPath(
  new URL('./install-electron-package-binary.mjs', import.meta.url)
)
/** Matches the fake package version and the platform/arch runInstallScript installs for. */
export const sharedEntryName = '41.5.0-linux-x64'
export const sharedEntryNameFor = (version) => `${version}-linux-x64`

export function mkTempProject() {
  const projectDir = mkdtempSync(join(tmpdir(), 'orca-install-electron-'))
  copyScriptWithLocalModules(sourceScriptPath, join(projectDir, 'config', 'scripts'))
  return projectDir
}

export function runInstallScript(projectDir, extraEnv = {}) {
  return spawnSync(process.execPath, ['config/scripts/install-electron-package-binary.mjs'], {
    cwd: projectDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      ELECTRON_CACHE: undefined,
      ORCA_ELECTRON_PACKAGE_CACHE_ROOT: undefined,
      npm_config_platform: 'linux',
      npm_config_arch: 'x64',
      ORCA_ELECTRON_PACKAGE_EXTRACTOR: join(projectDir, 'fake-extractor.cjs'),
      ...extraEnv
    }
  })
}

export function writeFakeElectronPackage(
  projectDir,
  { lazyRequireMarker = null, version = '41.5.0' } = {}
) {
  const electronDir = join(projectDir, 'node_modules', 'electron')
  mkdirSync(electronDir, { recursive: true })
  writeFileSync(join(electronDir, 'package.json'), JSON.stringify({ name: 'electron', version }))
  writeFileSync(join(electronDir, 'checksums.json'), '{}')
  writeFileSync(
    join(electronDir, 'index.js'),
    `
const fs = require('node:fs')
const path = require('node:path')
${lazyRequireMarker ? `fs.writeFileSync(${JSON.stringify(lazyRequireMarker)}, 'required')` : ''}
const pathFile = path.join(__dirname, 'path.txt')
if (!fs.existsSync(pathFile)) {
  throw new Error('Electron failed to install correctly, please delete node_modules/electron and try installing again')
}
module.exports = path.join(__dirname, 'dist', fs.readFileSync(pathFile, 'utf8'))
`
  )
}

export function writeFakeElectronDist(
  projectDir,
  { version = 'v41.5.0', executableContents = '', pathContents } = {}
) {
  const electronDir = join(projectDir, 'node_modules', 'electron')
  mkdirSync(join(electronDir, 'dist'), { recursive: true })
  writeFileSync(join(electronDir, 'dist/version'), version)
  writeFileSync(join(electronDir, 'dist/electron'), executableContents)
  if (pathContents !== undefined) {
    writeFileSync(join(electronDir, 'path.txt'), pathContents)
  }
}

export function writeFakeElectronGet(
  projectDir,
  {
    downloadNeverSettles = false,
    downloadFailures = 0,
    downloadErrorCode = 'ECONNRESET',
    downloadHttpStatus = null
  } = {}
) {
  const getDir = join(projectDir, 'node_modules', 'electron', 'node_modules', '@electron', 'get')
  mkdirSync(getDir, { recursive: true })
  writeFileSync(
    join(getDir, 'index.js'),
    `
const { mkdirSync, writeFileSync, appendFileSync } = require('node:fs')
const { join } = require('node:path')
let downloadAttempt = 0
exports.downloadArtifact = async function downloadArtifact(details) {
  downloadAttempt += 1
  appendFileSync(
    'electron-get.log',
    'cacheRoot=' + details.cacheRoot + ' platform=' + details.platform + ' arch=' + details.arch + ' force=' + details.force + '\\n'
  )
  if (${JSON.stringify(downloadNeverSettles)}) {
    return new Promise(() => {})
  }
  if (downloadAttempt <= ${JSON.stringify(downloadFailures)}) {
    if (${JSON.stringify(downloadHttpStatus)} != null) {
      const error = new Error('Response code ' + ${JSON.stringify(downloadHttpStatus)})
      error.response = { status: ${JSON.stringify(downloadHttpStatus)} }
      throw error
    }
    const cause = Object.assign(new Error('download failed'), {
      code: ${JSON.stringify(downloadErrorCode)}
    })
    throw Object.assign(new TypeError('fetch failed'), { cause })
  }
  mkdirSync(details.cacheRoot, { recursive: true })
  const artifactPath = join(details.cacheRoot, 'electron.zip')
  writeFileSync(artifactPath, 'fake zip')
  return artifactPath
}
`
  )
}

export function writeFakeExtractor(projectDir, { createExecutable, version = '41.5.0' }) {
  writeFileSync(
    join(projectDir, 'fake-extractor.cjs'),
    `
const { appendFileSync, mkdirSync, symlinkSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const extractDir = process.argv[3]
appendFileSync(join(__dirname, 'fake-extractor.log'), extractDir + '\\n')
mkdirSync(join(extractDir, 'locales'), { recursive: true })
if (${JSON.stringify(createExecutable)}) {
  writeFileSync(join(extractDir, 'electron'), '')
  writeFileSync(join(extractDir, 'electron.exe'), '')
  writeFileSync(join(extractDir, 'electron.d.ts'), 'replacement types')
  writeFileSync(join(extractDir, 'version'), ${JSON.stringify(`v${version}`)})
  if (process.platform !== 'win32') {
    symlinkSync('version', join(extractDir, 'version-link'))
  }
}
`
  )
}

export function writeTypeDefPublishFailurePreload(projectDir) {
  const preloadPath = join(projectDir, 'type-def-publish-failure.cjs')
  writeFileSync(
    preloadPath,
    `
const fs = require('node:fs')
const { syncBuiltinESMExports } = require('node:module')
const { basename, dirname } = require('node:path')
const renameSync = fs.renameSync
fs.renameSync = (source, target) => {
  if (basename(source) === 'electron.d.ts' && basename(dirname(source)) === 'dist') {
    const error = new Error('injected Electron type definition publish failure')
    error.code = 'EACCES'
    throw error
  }
  return renameSync(source, target)
}
syncBuiltinESMExports()
`
  )
  return preloadPath
}

export function initGitRepo(projectDir) {
  runGit(projectDir, ['init', '--quiet', '--initial-branch=main'])
  runGit(projectDir, ['config', 'user.email', 'orca-test@example.com'])
  runGit(projectDir, ['config', 'user.name', 'Orca Test'])
  runGit(projectDir, ['commit', '--quiet', '--allow-empty', '-m', 'init'])
}

export function addSiblingWorktree(projectDir, siblingDir) {
  runGit(projectDir, ['worktree', 'add', '--quiet', '-b', 'sibling', siblingDir])
  copyScriptWithLocalModules(sourceScriptPath, join(siblingDir, 'config', 'scripts'))
  return siblingDir
}

function runGit(projectDir, args) {
  execFileSync('git', ['-C', projectDir, ...args], { stdio: 'ignore' })
}

export function sharedCacheRoot(repoDir) {
  return join(repoDir, '.git', 'orca-cache', 'electron')
}

export function readSharedDistMarker(projectDir) {
  try {
    return readFileSync(join(projectDir, 'node_modules/electron/.orca-shared-dist'), 'utf8')
  } catch {
    return null
  }
}

export function readExtractorCallCount(projectDir) {
  try {
    return readFileSync(join(projectDir, 'fake-extractor.log'), 'utf8').trim().split('\n').length
  } catch {
    return 0
  }
}

export function writeNonDarwinPlatformPreload(projectDir) {
  const preloadPath = join(projectDir, 'non-darwin-platform.cjs')
  writeFileSync(
    preloadPath,
    `
Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
`
  )
  return preloadPath
}
