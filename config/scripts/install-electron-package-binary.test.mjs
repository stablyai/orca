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

      const result = runInstallScript(projectDir)

      expect(result.status, result.stderr).toBe(0)
      expect(readFileSync(join(projectDir, 'electron-get.log'), 'utf8')).toMatch(
        /cacheRoot=.*orca-electron-.*cache/
      )
      expect(readFileSync(join(projectDir, 'node_modules', 'electron', 'path.txt'), 'utf8')).toBe(
        'electron'
      )
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

function writeFakeElectronGet(projectDir, { downloadNeverSettles = false } = {}) {
  const getDir = join(projectDir, 'node_modules', 'electron', 'node_modules', '@electron', 'get')
  mkdirSync(getDir, { recursive: true })
  writeFileSync(
    join(getDir, 'index.js'),
    `
const { mkdirSync, writeFileSync, appendFileSync } = require('node:fs')
const { join } = require('node:path')
exports.downloadArtifact = async function downloadArtifact(details) {
  appendFileSync(
    'electron-get.log',
    'cacheRoot=' + details.cacheRoot + ' platform=' + details.platform + ' arch=' + details.arch + '\\n'
  )
  if (${JSON.stringify(downloadNeverSettles)}) {
    return new Promise(() => {})
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
  writeFileSync(join(extractDir, 'version'), 'v41.5.0')
  if (process.platform !== 'win32') {
    symlinkSync('version', join(extractDir, 'version-link'))
  }
}
`
  )
}
