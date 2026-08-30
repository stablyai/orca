import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const sourceScriptPath = fileURLToPath(
  new URL('./install-electron-package-binary.mjs', import.meta.url)
)

describe('install-electron-package-binary', () => {
  it('installs Electron from an isolated cache and repairs path.txt', () => {
    const projectDir = mkTempProject()

    try {
      writeFakeElectronPackage(projectDir)
      writeFakeElectronGet(projectDir)
      writeFakeExtractor(projectDir, { createExecutable: true })
      writeFakeElectronDist(projectDir, {
        version: 'v40.0.0',
        executableContents: 'old executable',
        pathContents: 'stale-path'
      })

      const result = runInstallScript(projectDir)

      expect(result.status, result.stderr).toBe(0)
      expect(readFileSync(join(projectDir, 'electron-get.log'), 'utf8')).toMatch(
        /cacheRoot=.*orca-electron-.*cache/
      )
      expect(readFileSync(join(projectDir, 'node_modules', 'electron', 'path.txt'), 'utf8')).toBe(
        'electron'
      )
      expect(readFileSync(join(projectDir, 'node_modules/electron/electron.d.ts'), 'utf8')).toBe(
        'replacement types'
      )
      expect(existsSync(join(projectDir, 'node_modules/electron/dist/electron.d.ts'))).toBe(false)
      if (process.platform !== 'win32') {
        expect(
          lstatSync(
            join(projectDir, 'node_modules', 'electron', 'dist', 'version-link')
          ).isSymbolicLink()
        ).toBe(true)
      }
      expect(result.stdout).toContain('Repaired Electron path.txt -> electron')
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('repairs existing Electron path metadata without downloading', () => {
    const projectDir = mkTempProject()

    try {
      writeFakeElectronPackage(projectDir)
      writeFakeElectronGet(projectDir)
      writeFakeElectronDist(projectDir)

      const result = runInstallScript(projectDir)

      expect(result.status, result.stderr).toBe(0)
      expect(readFileSync(join(projectDir, 'node_modules/electron/path.txt'), 'utf8')).toBe(
        'electron'
      )
      expect(result.stdout).toContain('Repaired Electron path.txt -> electron')
      expect(existsSync(join(projectDir, 'electron-get.log'))).toBe(false)
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('preserves an existing Electron distribution when replacement download fails', () => {
    const projectDir = mkTempProject()

    try {
      writeFakeElectronPackage(projectDir)
      writeFakeElectronGet(projectDir, { downloadFailures: 1, downloadErrorCode: 'EACCES' })
      writeFakeElectronDist(projectDir, {
        version: 'v40.0.0',
        executableContents: 'existing executable',
        pathContents: 'electron'
      })

      const result = runInstallScript(projectDir)
      const electronDir = join(projectDir, 'node_modules/electron')

      expect(result.status).toBe(1)
      expect(readFileSync(join(electronDir, 'dist/version'), 'utf8')).toBe('v40.0.0')
      expect(readFileSync(join(electronDir, 'dist/electron'), 'utf8')).toBe('existing executable')
      expect(readFileSync(join(electronDir, 'path.txt'), 'utf8')).toBe('electron')
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('restores an existing Electron distribution when publishing its type definitions fails', () => {
    const projectDir = mkTempProject()

    try {
      writeFakeElectronPackage(projectDir)
      writeFakeElectronGet(projectDir)
      writeFakeExtractor(projectDir, { createExecutable: true })
      writeFakeElectronDist(projectDir, {
        version: 'v40.0.0',
        executableContents: 'existing executable',
        pathContents: 'electron'
      })
      writeFileSync(join(projectDir, 'node_modules/electron/electron.d.ts'), 'existing types')
      const preloadPath = writeTypeDefPublishFailurePreload(projectDir)

      const result = runInstallScript(projectDir, {
        NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${preloadPath}`]
          .filter(Boolean)
          .join(' ')
      })
      const electronDir = join(projectDir, 'node_modules/electron')

      expect(result.status).toBe(1)
      expect(result.stderr).toContain('injected Electron type definition publish failure')
      expect(readFileSync(join(electronDir, 'dist/version'), 'utf8')).toBe('v40.0.0')
      expect(readFileSync(join(electronDir, 'dist/electron'), 'utf8')).toBe('existing executable')
      expect(readFileSync(join(electronDir, 'path.txt'), 'utf8')).toBe('electron')
      expect(readFileSync(join(electronDir, 'electron.d.ts'), 'utf8')).toBe('existing types')
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('uses Electron 42 install env vars before npm config platform flags', () => {
    const projectDir = mkTempProject()

    try {
      writeFakeElectronPackage(projectDir)
      writeFakeElectronGet(projectDir)
      writeFakeExtractor(projectDir, { createExecutable: true })

      const result = runInstallScript(projectDir, {
        ELECTRON_INSTALL_PLATFORM: 'win32',
        ELECTRON_INSTALL_ARCH: 'arm64',
        npm_config_platform: 'linux',
        npm_config_arch: 'x64'
      })

      expect(result.status, result.stderr).toBe(0)
      expect(readFileSync(join(projectDir, 'electron-get.log'), 'utf8')).toContain(
        'platform=win32 arch=arm64'
      )
      expect(readFileSync(join(projectDir, 'node_modules', 'electron', 'path.txt'), 'utf8')).toBe(
        'electron.exe'
      )
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('does not trigger Electron 42 lazy require downloads while checking install state', () => {
    const projectDir = mkTempProject()

    try {
      writeFakeElectronPackage(projectDir, { lazyRequireMarker: 'lazy-require.marker' })
      writeFakeElectronGet(projectDir)
      writeFakeExtractor(projectDir, { createExecutable: true })

      const result = runInstallScript(projectDir)

      expect(result.status, result.stderr).toBe(0)
      expect(existsSync(join(projectDir, 'lazy-require.marker'))).toBe(false)
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('retries transient Electron download failures', () => {
    const projectDir = mkTempProject()

    try {
      writeFakeElectronPackage(projectDir)
      writeFakeElectronGet(projectDir, {
        downloadFailures: 1,
        downloadErrorCode: 'ECONNRESET'
      })
      writeFakeExtractor(projectDir, { createExecutable: true })

      const result = runInstallScript(projectDir, {
        ORCA_ELECTRON_PACKAGE_RETRY_DELAYS_MS: '0,0'
      })

      expect(result.status, result.stderr).toBe(0)
      expect(
        readFileSync(join(projectDir, 'electron-get.log'), 'utf8').trim().split('\n')
      ).toHaveLength(2)
      expect(result.stderr).toContain('Transient Electron download failure (ECONNRESET)')
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('retries HTTP/2 stream refusal Electron download failures', () => {
    const projectDir = mkTempProject()

    try {
      writeFakeElectronPackage(projectDir)
      writeFakeElectronGet(projectDir, {
        downloadFailures: 1,
        downloadErrorCode: 'ERR_HTTP2_STREAM_ERROR'
      })
      writeFakeExtractor(projectDir, { createExecutable: true })

      const result = runInstallScript(projectDir, {
        ORCA_ELECTRON_PACKAGE_RETRY_DELAYS_MS: '0,0'
      })

      expect(result.status, result.stderr).toBe(0)
      expect(
        readFileSync(join(projectDir, 'electron-get.log'), 'utf8').trim().split('\n')
      ).toHaveLength(2)
      expect(result.stderr).toContain(
        'Transient Electron download failure (ERR_HTTP2_STREAM_ERROR)'
      )
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('retries Electron download HTTP 503 failures from Fetch Response.status', () => {
    const projectDir = mkTempProject()

    try {
      writeFakeElectronPackage(projectDir)
      writeFakeElectronGet(projectDir, {
        downloadFailures: 1,
        downloadHttpStatus: 503
      })
      writeFakeExtractor(projectDir, { createExecutable: true })

      const result = runInstallScript(projectDir, {
        ORCA_ELECTRON_PACKAGE_RETRY_DELAYS_MS: '0,0'
      })

      expect(result.status, result.stderr).toBe(0)
      expect(
        readFileSync(join(projectDir, 'electron-get.log'), 'utf8').trim().split('\n')
      ).toHaveLength(2)
      expect(result.stderr).toContain('Transient Electron download failure (HTTP 503)')
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('fails after exhausting transient Electron download retries', () => {
    const projectDir = mkTempProject()

    try {
      writeFakeElectronPackage(projectDir)
      writeFakeElectronGet(projectDir, {
        downloadFailures: 5,
        downloadErrorCode: 'ECONNRESET'
      })
      writeFakeExtractor(projectDir, { createExecutable: true })

      const result = runInstallScript(projectDir, {
        ORCA_ELECTRON_PACKAGE_RETRY_DELAYS_MS: '0,0'
      })

      expect(result.status).toBe(1)
      expect(
        readFileSync(join(projectDir, 'electron-get.log'), 'utf8').trim().split('\n')
      ).toHaveLength(3)
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('rejects invalid Electron download retry delays before downloading', () => {
    const projectDir = mkTempProject()

    try {
      writeFakeElectronPackage(projectDir)
      writeFakeElectronGet(projectDir)
      writeFakeExtractor(projectDir, { createExecutable: true })

      const result = runInstallScript(projectDir, {
        ORCA_ELECTRON_PACKAGE_RETRY_DELAYS_MS: '0,nope'
      })

      expect(result.status).toBe(1)
      expect(result.stderr).toContain(
        'ORCA_ELECTRON_PACKAGE_RETRY_DELAYS_MS must contain non-negative integers'
      )
      expect(existsSync(join(projectDir, 'electron-get.log'))).toBe(false)
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('does not retry permanent Electron download failures', () => {
    const projectDir = mkTempProject()

    try {
      writeFakeElectronPackage(projectDir)
      writeFakeElectronGet(projectDir, {
        downloadFailures: 3,
        downloadErrorCode: 'EACCES'
      })
      writeFakeExtractor(projectDir, { createExecutable: true })

      const result = runInstallScript(projectDir, {
        ORCA_ELECTRON_PACKAGE_RETRY_DELAYS_MS: '0,0'
      })

      expect(result.status).toBe(1)
      expect(
        readFileSync(join(projectDir, 'electron-get.log'), 'utf8').trim().split('\n')
      ).toHaveLength(1)
      expect(result.stderr).not.toContain('Transient Electron download failure')
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('fails instead of silently accepting a partial Electron extract', () => {
    const projectDir = mkTempProject()

    try {
      writeFakeElectronPackage(projectDir)
      writeFakeElectronGet(projectDir)
      writeFakeExtractor(projectDir, { createExecutable: false })
      mkdirSync(join(projectDir, 'node_modules', 'electron', 'dist', 'locales'), {
        recursive: true
      })
      writeFileSync(join(projectDir, 'node_modules', 'electron', 'path.txt'), 'stale-path')

      const result = runInstallScript(projectDir)

      expect(result.status).toBe(1)
      expect(result.stderr).toContain('Electron archive extract did not contain executable')
      expect(result.stderr).toContain('extractEntries=locales')
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('does not exit successfully when Electron download never settles', () => {
    const projectDir = mkTempProject()

    try {
      writeFakeElectronPackage(projectDir)
      writeFakeElectronGet(projectDir, { downloadNeverSettles: true })
      writeFakeExtractor(projectDir, { createExecutable: false })

      const result = runInstallScript(projectDir)

      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('Detected unsettled top-level await')
      expect(existsSync(join(projectDir, 'node_modules', 'electron', 'path.txt'))).toBe(false)
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })
})

function mkTempProject() {
  const projectDir = mkdtempSync(join(tmpdir(), 'orca-install-electron-'))
  mkdirSync(join(projectDir, 'config', 'scripts'), { recursive: true })
  copyFileSync(
    sourceScriptPath,
    join(projectDir, 'config', 'scripts', 'install-electron-package-binary.mjs')
  )
  return projectDir
}

function runInstallScript(projectDir, extraEnv = {}) {
  return spawnSync(process.execPath, ['config/scripts/install-electron-package-binary.mjs'], {
    cwd: projectDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      npm_config_platform: 'linux',
      npm_config_arch: 'x64',
      ORCA_ELECTRON_PACKAGE_EXTRACTOR: join(projectDir, 'fake-extractor.cjs'),
      ...extraEnv
    }
  })
}

function writeFakeElectronPackage(projectDir, { lazyRequireMarker = null } = {}) {
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
${lazyRequireMarker ? `fs.writeFileSync(${JSON.stringify(lazyRequireMarker)}, 'required')` : ''}
const pathFile = path.join(__dirname, 'path.txt')
if (!fs.existsSync(pathFile)) {
  throw new Error('Electron failed to install correctly, please delete node_modules/electron and try installing again')
}
module.exports = path.join(__dirname, 'dist', fs.readFileSync(pathFile, 'utf8'))
`
  )
}

function writeFakeElectronDist(
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

function writeFakeElectronGet(
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
    'cacheRoot=' + details.cacheRoot + ' platform=' + details.platform + ' arch=' + details.arch + '\\n'
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

function writeFakeExtractor(projectDir, { createExecutable }) {
  writeFileSync(
    join(projectDir, 'fake-extractor.cjs'),
    `
const { mkdirSync, symlinkSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const extractDir = process.argv[3]
mkdirSync(join(extractDir, 'locales'), { recursive: true })
if (${JSON.stringify(createExecutable)}) {
  writeFileSync(join(extractDir, 'electron'), '')
  writeFileSync(join(extractDir, 'electron.exe'), '')
  writeFileSync(join(extractDir, 'electron.d.ts'), 'replacement types')
  writeFileSync(join(extractDir, 'version'), 'v41.5.0')
  if (process.platform !== 'win32') {
    symlinkSync('version', join(extractDir, 'version-link'))
  }
}
`
  )
}

function writeTypeDefPublishFailurePreload(projectDir) {
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
