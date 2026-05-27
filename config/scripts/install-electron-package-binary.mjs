#!/usr/bin/env node

import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { platform as osPlatform, tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const electronPackageDir = resolve(projectDir, 'node_modules/electron')
const electronRequire = createRequire(resolve(electronPackageDir, 'package.json'))
const { version: electronVersion } = electronRequire('./package.json')
const { downloadArtifact } = electronRequire('@electron/get')
const extract = electronRequire('extract-zip')
const platformPath = getElectronPlatformPath()

main().catch((error) => {
  console.error('[electron-package] Failed to install Electron package binary.')
  console.error(error)
  logElectronInstallDiagnostics()
  process.exit(1)
})

async function main() {
  if (electronPackageLoads()) {
    return
  }

  // Why: PR tests run under system Node after native modules are rebuilt for
  // Node. Install only Electron's npm package binary here; do not run the full
  // Electron native-module rebuild path, which would undo the Node ABI rebuild.
  console.log('[electron-package] Electron package binary is missing; running Electron install.')
  await installElectronPackageBinary()

  repairElectronPathFile()

  if (!electronPackageLoads()) {
    logElectronInstallDiagnostics()
    console.error('[electron-package] Electron package is still unavailable after install.')
    process.exit(1)
  }
}

function electronPackageLoads() {
  try {
    require('electron')
    return true
  } catch {
    return false
  }
}

function repairElectronPathFile() {
  const electronExecutable = resolve(electronPackageDir, 'dist', platformPath)
  if (!existsSync(electronExecutable)) {
    return
  }

  const pathFile = resolve(electronPackageDir, 'path.txt')
  let currentPath = ''
  try {
    currentPath = readFileSync(pathFile, 'utf8')
  } catch {
    // Missing path.txt is the common CI failure this script repairs.
  }

  if (currentPath !== platformPath) {
    writeFileSync(pathFile, platformPath)
    console.log(`[electron-package] Repaired Electron path.txt -> ${platformPath}`)
  }
}

async function installElectronPackageBinary() {
  const electronDistDir = resolve(electronPackageDir, 'dist')
  const tempDir = mkdtempSync(resolve(tmpdir(), 'orca-electron-'))

  try {
    const zipPath = await downloadArtifact({
      version: electronVersion,
      artifactName: 'electron',
      platform: process.env.npm_config_platform || osPlatform(),
      arch: process.env.npm_config_arch || process.arch,
      force: true,
      tempDirectory: tempDir,
      ...(shouldUseRemoteChecksums() ? {} : { checksums: electronRequire('./checksums.json') })
    })

    rmSync(electronDistDir, { recursive: true, force: true })
    await extract(zipPath, { dir: electronDistDir })

    const srcTypeDefPath = resolve(electronDistDir, 'electron.d.ts')
    if (existsSync(srcTypeDefPath)) {
      renameSync(srcTypeDefPath, resolve(electronPackageDir, 'electron.d.ts'))
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

function shouldUseRemoteChecksums() {
  return Boolean(
    process.env.electron_use_remote_checksums ||
      process.env.npm_config_electron_use_remote_checksums
  )
}

function logElectronInstallDiagnostics() {
  const electronDistDir = resolve(electronPackageDir, 'dist')
  const pathFile = resolve(electronPackageDir, 'path.txt')
  console.error('[electron-package] Electron install diagnostics:')
  console.error(`  packageDir=${electronPackageDir} exists=${existsSync(electronPackageDir)}`)
  console.error(`  distDir=${electronDistDir} exists=${existsSync(electronDistDir)}`)
  console.error(`  pathFile=${pathFile} exists=${existsSync(pathFile)}`)
  console.error(`  platformPath=${platformPath}`)
  if (existsSync(electronDistDir)) {
    console.error(`  distEntries=${safeReaddir(electronDistDir).join(', ')}`)
  }
}

function safeReaddir(targetPath) {
  try {
    return readdirSync(targetPath).slice(0, 40)
  } catch {
    return []
  }
}

function getElectronPlatformPath() {
  const targetPlatform = process.env.npm_config_platform || osPlatform()
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
