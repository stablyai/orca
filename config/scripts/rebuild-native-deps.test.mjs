import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
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

describe('rebuild-native-deps patched node-pty rebuild', () => {
  it.skipIf(process.platform === 'win32')(
    'rebuilds when Electron can load node-pty but patched build artifacts are missing',
    () => {
      const projectDir = mkTempProject()

      try {
        const rebuildLogPath = join(projectDir, 'electron-rebuild.log')
        writeFakeUsableElectronPackage(projectDir)
        writeFakeElectronRebuild(projectDir, { logPathEnv: 'ORCA_REBUILD_TEST_LOG' })
        writeFakeLoadableNodePty(projectDir)
        writeNodePtyPatchFile(projectDir)

        const result = runRebuildScript(projectDir, {
          ORCA_REBUILD_TEST_LOG: rebuildLogPath
        })

        expect(result.status, result.stderr).toBe(0)
        expect(result.stdout).toContain(
          'Patched node-pty build artifacts are missing; rebuilding from source.'
        )

        const rebuildCall = JSON.parse(readFileSync(rebuildLogPath, 'utf8').trim())
        expect(rebuildCall.onlyModules).toEqual(['node-pty'])
        expect(rebuildCall.ignoreModules).toEqual(['cpu-features'])
        expect(rebuildCall.force).toBe(true)
      } finally {
        rmSync(projectDir, { recursive: true, force: true })
      }
    }
  )

  it.skipIf(process.platform === 'win32')(
    'keeps the Electron load-probe fast path once patched node-pty artifacts exist',
    () => {
      const projectDir = mkTempProject()

      try {
        const rebuildLogPath = join(projectDir, 'electron-rebuild.log')
        writeFakeUsableElectronPackage(projectDir)
        writeFakeElectronRebuild(projectDir, { logPathEnv: 'ORCA_REBUILD_TEST_LOG' })
        writeFakeLoadableNodePty(projectDir, { nativeDir: '../build/Release/' })
        writeNodePtyPatchFile(projectDir)
        writePatchedNodePtyBuildArtifacts(projectDir)

        const result = runRebuildScript(projectDir, {
          ORCA_REBUILD_TEST_LOG: rebuildLogPath
        })

        expect(result.status, result.stderr).toBe(0)
        expect(result.stdout).toContain(
          'Native modules already load in Electron; skipping rebuild.'
        )
        expect(existsSync(rebuildLogPath)).toBe(false)
      } finally {
        rmSync(projectDir, { recursive: true, force: true })
      }
    }
  )

  it.skipIf(process.platform === 'win32')(
    'rebuilds when patched artifacts exist but Electron falls back to node-pty prebuilds',
    () => {
      const projectDir = mkTempProject()

      try {
        const rebuildLogPath = join(projectDir, 'electron-rebuild.log')
        writeFakeUsableElectronPackage(projectDir)
        writeFakeElectronRebuild(projectDir, { logPathEnv: 'ORCA_REBUILD_TEST_LOG' })
        writeFakeLoadableNodePty(projectDir, { nativeDir: '../prebuilds/darwin-arm64/' })
        writeNodePtyPatchFile(projectDir)
        writePatchedNodePtyBuildArtifacts(projectDir)

        const result = runRebuildScript(projectDir, {
          ORCA_REBUILD_TEST_LOG: rebuildLogPath
        })

        expect(result.status, result.stderr).toBe(0)
        expect(result.stdout).toContain('Native modules do not load in Electron; rebuilding.')
        expect(result.stdout).toContain("expected build/Release so Orca's node-pty patch is active")

        const rebuildCall = JSON.parse(readFileSync(rebuildLogPath, 'utf8').trim())
        expect(rebuildCall.onlyModules).toEqual(['node-pty'])
        expect(rebuildCall.force).toBe(true)
      } finally {
        rmSync(projectDir, { recursive: true, force: true })
      }
    }
  )
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
  const env = {
    ...process.env,
    npm_config_platform: 'linux',
    npm_config_arch: 'x64'
  }
  for (const key of Object.keys(env)) {
    if (
      key.toLowerCase() === 'orca_strict_electron_install' ||
      key.toLowerCase() === 'npm_lifecycle_event'
    ) {
      delete env[key]
    }
  }
  return spawnSync(process.execPath, ['config/scripts/rebuild-native-deps.mjs'], {
    cwd: projectDir,
    encoding: 'utf8',
    env: {
      ...env,
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

function writeFakeElectronRebuild(projectDir, { logPathEnv = null } = {}) {
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

function writeFakeUsableElectronPackage(projectDir) {
  writeFakeElectronPackage(projectDir)
  const electronDir = join(projectDir, 'node_modules', 'electron')
  const electronPath = join(electronDir, 'dist', 'electron')
  mkdirSync(join(electronDir, 'dist'), { recursive: true })
  writeFileSync(join(electronDir, 'path.txt'), 'electron')
  writeFileSync(join(electronDir, 'dist', 'version'), 'v41.5.0')
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

function writeFakeLoadableNodePty(projectDir, { nativeDir = 'prebuilds/pty' } = {}) {
  const nodePtyDir = join(projectDir, 'node_modules', 'node-pty')
  mkdirSync(join(nodePtyDir, 'lib'), { recursive: true })
  writeFileSync(join(nodePtyDir, 'index.js'), 'module.exports = {}\n')
  writeFileSync(
    join(nodePtyDir, 'lib', 'utils.js'),
    `
exports.loadNativeModule = function loadNativeModule(nativeName) {
  return { dir: ${JSON.stringify(nativeDir)}, module: { nativeName } }
}
`
  )
}

function writeNodePtyPatchFile(projectDir) {
  mkdirSync(join(projectDir, 'config', 'patches'), { recursive: true })
  writeFileSync(join(projectDir, 'config', 'patches', 'node-pty@1.1.0.patch'), 'patch marker\n')
}

function writePatchedNodePtyBuildArtifacts(projectDir) {
  const buildDir = join(projectDir, 'node_modules', 'node-pty', 'build', 'Release')
  mkdirSync(buildDir, { recursive: true })
  writeFileSync(join(buildDir, 'pty.node'), '')
  writeFileSync(join(buildDir, 'spawn-helper'), '')
}
