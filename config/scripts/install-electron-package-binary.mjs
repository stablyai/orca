#!/usr/bin/env node

import { createHash } from 'node:crypto'
import {
  createReadStream,
  createWriteStream,
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
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const electronPackageDir = resolve(projectDir, 'node_modules/electron')
const electronRequire = createRequire(resolve(electronPackageDir, 'package.json'))
const { version: electronVersion } = electronRequire('./package.json')
const extract = electronRequire('extract-zip')
const platformPath = getElectronPlatformPath()

if (electronPackageLoads()) {
  process.exit(0)
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
  const artifactName = getElectronArtifactName()
  const tempDir = mkdtempSync(resolve(tmpdir(), 'orca-electron-'))
  const zipPath = resolve(tempDir, artifactName)

  try {
    await downloadElectronArtifact(artifactName, zipPath)
    await verifyElectronArtifactChecksum(artifactName, zipPath)

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

async function downloadElectronArtifact(artifactName, zipPath) {
  const artifactUrl = new URL(`v${electronVersion}/${artifactName}`, getElectronReleaseBaseUrl())
  console.log(`[electron-package] Downloading ${artifactUrl}`)

  const response = await fetch(artifactUrl)
  if (!response.ok) {
    throw new Error(`Failed to download ${artifactName}: ${response.status} ${response.statusText}`)
  }
  if (!response.body) {
    throw new Error(`Failed to download ${artifactName}: empty response body`)
  }

  await pipeline(Readable.fromWeb(response.body), createWriteStream(zipPath))
}

async function verifyElectronArtifactChecksum(artifactName, zipPath) {
  if (
    process.env.electron_use_remote_checksums ||
    process.env.npm_config_electron_use_remote_checksums
  ) {
    return
  }

  const expected = electronRequire('./checksums.json')[artifactName]
  if (!expected) {
    throw new Error(`Missing Electron checksum for ${artifactName}`)
  }

  const hash = createHash('sha256')
  for await (const chunk of createReadStream(zipPath)) {
    hash.update(chunk)
  }
  const actual = hash.digest('hex')
  if (actual !== expected) {
    throw new Error(`Checksum mismatch for ${artifactName}: expected ${expected}, got ${actual}`)
  }
}

function getElectronArtifactName() {
  return `electron-v${electronVersion}-${process.env.npm_config_platform || osPlatform()}-${
    process.env.npm_config_arch || process.arch
  }.zip`
}

function getElectronReleaseBaseUrl() {
  const configuredMirror = process.env.ELECTRON_MIRROR || process.env.npm_config_electron_mirror
  const baseUrl = configuredMirror || 'https://github.com/electron/electron/releases/download/'
  return baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
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
