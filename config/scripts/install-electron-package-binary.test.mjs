import {
  chmodSync,
  copyFileSync,
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
      writeFakeExtractZip(projectDir, { createExecutable: true })

      const result = runInstallScript(projectDir)

      expect(result.status, result.stderr).toBe(0)
      expect(readFileSync(join(projectDir, 'electron-get.log'), 'utf8')).toMatch(
        /cacheRoot=.*orca-electron-.*cache/
      )
      expect(readFileSync(join(projectDir, 'node_modules', 'electron', 'path.txt'), 'utf8')).toBe(
        'electron'
      )
      expect(result.stdout).toContain('Repaired Electron path.txt -> electron')
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('fails instead of silently accepting a partial Electron extract', () => {
    const projectDir = mkTempProject()

    try {
      writeFakeElectronPackage(projectDir)
      writeFakeElectronGet(projectDir)
      writeFakeExtractZip(projectDir, { createExecutable: false })
      mkdirSync(join(projectDir, 'node_modules', 'electron', 'dist', 'locales'), {
        recursive: true
      })
      writeFileSync(join(projectDir, 'node_modules', 'electron', 'path.txt'), 'stale-path')

      const result = runInstallScript(projectDir)

      expect(result.status).toBe(1)
      expect(result.stderr).toContain('Electron package is still unavailable after install')
      expect(result.stderr).toContain('distEntries=locales')
      expect(result.stderr).toContain('pathFile=')
      expect(result.stderr).toContain('exists=false')
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

function runInstallScript(projectDir) {
  return spawnSync(process.execPath, ['config/scripts/install-electron-package-binary.mjs'], {
    cwd: projectDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      npm_config_platform: 'linux',
      npm_config_arch: 'x64'
    }
  })
}

function writeFakeElectronPackage(projectDir) {
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
module.exports = path.join(__dirname, 'dist', fs.readFileSync(pathFile, 'utf8'))
`
  )
}

function writeFakeElectronGet(projectDir) {
  const getDir = join(projectDir, 'node_modules', 'electron', 'node_modules', '@electron', 'get')
  mkdirSync(getDir, { recursive: true })
  writeFileSync(
    join(getDir, 'index.js'),
    `
const { mkdirSync, writeFileSync, appendFileSync } = require('node:fs')
const { join } = require('node:path')
exports.downloadArtifact = async function downloadArtifact(details) {
  appendFileSync('electron-get.log', 'cacheRoot=' + details.cacheRoot + '\\n')
  mkdirSync(details.cacheRoot, { recursive: true })
  const artifactPath = join(details.cacheRoot, 'electron.zip')
  writeFileSync(artifactPath, 'fake zip')
  return artifactPath
}
`
  )
}

function writeFakeExtractZip(projectDir, { createExecutable }) {
  const extractDir = join(projectDir, 'node_modules', 'electron', 'node_modules', 'extract-zip')
  mkdirSync(extractDir, { recursive: true })
  writeFileSync(
    join(extractDir, 'index.js'),
    `
const { mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
module.exports = async function extract(_zipPath, options) {
  mkdirSync(join(options.dir, 'locales'), { recursive: true })
  if (${JSON.stringify(createExecutable)}) {
    writeFileSync(join(options.dir, 'electron'), '')
    writeFileSync(join(options.dir, 'version'), 'v41.5.0')
  }
}
`
  )
  chmodSync(join(extractDir, 'index.js'), 0o755)
}
