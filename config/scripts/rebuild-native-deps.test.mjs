import { spawnSync } from 'node:child_process'
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
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const sourceScriptPath = fileURLToPath(new URL('./rebuild-native-deps.mjs', import.meta.url))
const sourceInstallScriptPath = fileURLToPath(
  new URL('./install-electron-package-binary.mjs', import.meta.url)
)

describe('rebuild-native-deps Electron install fallback', () => {
  it('continues non-strict postinstall when Electron retry download fails', () => {
    const projectDir = mkTempProject()

    try {
      writeFakeElectronPackage(projectDir)
      writeFakeElectronGet(projectDir, { downloadRejects: true })
      writeFakeExtractZip(projectDir, { createExecutable: false })
      writeFakeElectronRebuild(projectDir)

      const result = runRebuildScript(projectDir, {
        npm_lifecycle_event: 'postinstall',
        ORCA_STRICT_ELECTRON_INSTALL: ''
      })

      expect(result.status, result.stderr).toBe(0)
      expect(result.stderr).toContain('Electron install retry failed')
      expect(result.stderr).toContain(
        'Continuing postinstall because Electron binary installation failed'
      )
      expect(readFileSync(join(projectDir, 'electron-get.log'), 'utf8')).toBe(
        'download attempted\n'
      )
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('fails strict postinstall when Electron retry download fails', () => {
    const projectDir = mkTempProject()

    try {
      writeFakeElectronPackage(projectDir)
      writeFakeElectronGet(projectDir, { downloadRejects: true })
      writeFakeExtractZip(projectDir, { createExecutable: false })
      writeFakeElectronRebuild(projectDir)

      const result = runRebuildScript(projectDir, {
        npm_lifecycle_event: 'postinstall',
        ORCA_STRICT_ELECTRON_INSTALL: '1'
      })

      expect(result.status).toBe(1)
      expect(result.stderr).toContain('Electron install retry failed')
      expect(result.stderr).not.toContain(
        'Continuing postinstall because Electron binary installation failed'
      )
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('fails non-postinstall rebuild commands when Electron retry download fails', () => {
    const projectDir = mkTempProject()

    try {
      writeFakeElectronPackage(projectDir)
      writeFakeElectronGet(projectDir, { downloadRejects: true })
      writeFakeExtractZip(projectDir, { createExecutable: false })
      writeFakeElectronRebuild(projectDir)

      const result = runRebuildScript(projectDir)

      expect(result.status).toBe(1)
      expect(result.stderr).toContain('Electron install retry failed')
      expect(result.stderr).not.toContain(
        'Continuing postinstall because Electron binary installation failed'
      )
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('clears partial Electron package contents before retrying install', () => {
    const projectDir = mkTempProject()

    try {
      writeFakeElectronPackage(projectDir)
      writeFakeElectronGet(projectDir, { logPartialStateBeforeInstall: true })
      writeFakeExtractZip(projectDir, { createExecutable: false })
      writeFakeElectronRebuild(projectDir)
      mkdirSync(join(projectDir, 'node_modules', 'electron', 'dist', 'locales'), {
        recursive: true
      })
      writeFileSync(
        join(projectDir, 'node_modules', 'electron', 'dist', 'locales', 'stale.pak'),
        ''
      )
      writeFileSync(join(projectDir, 'node_modules', 'electron', 'path.txt'), 'stale-path')

      const result = runRebuildScript(projectDir, {
        ORCA_STRICT_ELECTRON_INSTALL: '1'
      })

      expect(result.status).toBe(1)
      expect(readFileSync(join(projectDir, 'electron-get.log'), 'utf8')).toBe(
        'partial cleared\ndownload attempted\n'
      )
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })
})

function mkTempProject() {
  const projectDir = mkdtempSync(join(tmpdir(), 'orca-rebuild-native-deps-'))
  mkdirSync(join(projectDir, 'config', 'scripts'), { recursive: true })
  copyFileSync(sourceScriptPath, join(projectDir, 'config', 'scripts', 'rebuild-native-deps.mjs'))
  copyFileSync(
    sourceInstallScriptPath,
    join(projectDir, 'config', 'scripts', 'install-electron-package-binary.mjs')
  )
  return projectDir
}

function runRebuildScript(projectDir, extraEnv = {}) {
  return spawnSync(process.execPath, ['config/scripts/rebuild-native-deps.mjs'], {
    cwd: projectDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      npm_config_platform: 'linux',
      npm_config_arch: 'x64',
      ...extraEnv
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
const electronPath = path.join(__dirname, 'dist', fs.readFileSync(pathFile, 'utf8'))
if (!fs.existsSync(electronPath)) {
  throw new Error('Electron failed to install correctly, please delete node_modules/electron and try installing again')
}
module.exports = electronPath
`
  )
}

function writeFakeElectronGet(
  projectDir,
  { downloadRejects = false, logPartialStateBeforeInstall = false } = {}
) {
  const getDir = join(projectDir, 'node_modules', 'electron', 'node_modules', '@electron', 'get')
  mkdirSync(getDir, { recursive: true })
  writeFileSync(
    join(getDir, 'index.js'),
    `
const { appendFileSync, existsSync, mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
exports.downloadArtifact = async function downloadArtifact(details) {
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

function writeFakeElectronRebuild(projectDir) {
  const rebuildDir = join(projectDir, 'node_modules', '@electron', 'rebuild')
  mkdirSync(rebuildDir, { recursive: true })
  writeFileSync(join(rebuildDir, 'package.json'), JSON.stringify({ type: 'module' }))
  writeFileSync(join(rebuildDir, 'index.js'), 'export async function rebuild() {}\n')
}
