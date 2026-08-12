#!/usr/bin/env node

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { platform as osPlatform, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const projectDir = resolve(import.meta.dirname, '../..')
const electronPackageDir = resolve(projectDir, 'node_modules/electron')
const electronRequire = createRequire(resolve(electronPackageDir, 'package.json'))
const { version: electronVersion } = electronRequire('./package.json')
const { downloadArtifact } = electronRequire('@electron/get')
const targetPlatform = getElectronTargetPlatform()
const targetArch = getElectronTargetArch()
const platformPath = getElectronPlatformPath(targetPlatform)
const transientDownloadErrorCodes = new Set([
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  // GitHub release CDN can refuse HTTP/2 streams under load; retry like socket resets.
  'ERR_HTTP2_STREAM_ERROR',
  'ENETDOWN',
  'ENETRESET',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET'
])

try {
  // Why: Electron's own install.js can exit 0 while an async extract promise is
  // still unsettled, leaving a partial dist/. Top-level await makes that fail.
  await main()
} catch (error) {
  console.error('[electron-package] Failed to install Electron package binary.')
  console.error(error)
  logElectronInstallDiagnostics()
  process.exit(1)
}

async function main() {
  if (electronPackageIsUsable()) {
    return
  }

  // Why: PR tests run under system Node after native modules are rebuilt for
  // Node. Install only Electron's npm package binary here; do not run the full
  // Electron native-module rebuild path, which would undo the Node ABI rebuild.
  console.log('[electron-package] Electron package binary is missing; running Electron install.')
  resetPartialElectronInstall()
  await installElectronPackageBinary()

  repairElectronPathFile()

  if (!electronPackageIsUsable()) {
    logElectronInstallDiagnostics()
    console.error('[electron-package] Electron package is still unavailable after install.')
    process.exit(1)
  }
}

function electronPackageIsUsable() {
  try {
    const installedVersion = readFileSync(resolve(electronPackageDir, 'dist', 'version'), 'utf8')
      .trim()
      .replace(/^v/, '')
    const installedPlatformPath = readFileSync(resolve(electronPackageDir, 'path.txt'), 'utf8')
    return (
      installedVersion === electronVersion &&
      installedPlatformPath === platformPath &&
      existsSync(getElectronExecutablePath())
    )
  } catch {
    return false
  }
}

function getElectronExecutablePath() {
  return process.env.ELECTRON_OVERRIDE_DIST_PATH
    ? resolve(process.env.ELECTRON_OVERRIDE_DIST_PATH, platformPath)
    : resolve(electronPackageDir, 'dist', platformPath)
}

function resetPartialElectronInstall() {
  rmSync(resolve(electronPackageDir, 'dist'), { recursive: true, force: true })
  rmSync(resolve(electronPackageDir, 'path.txt'), { force: true })
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
  const cacheRoot = join(tempDir, 'cache')
  const extractDir = join(tempDir, 'extract')

  try {
    const downloadOptions = {
      version: electronVersion,
      artifactName: 'electron',
      platform: targetPlatform,
      arch: targetArch,
      cacheRoot,
      force: true,
      tempDirectory: tempDir,
      ...(shouldUseRemoteChecksums() ? {} : { checksums: electronRequire('./checksums.json') })
    }
    const zipPath = await downloadElectronArtifactWithRetry(downloadOptions)

    // Why: CI has observed partial extracts directly under node_modules/electron
    // that leave only dist/locales. Verify in temp before replacing package dist.
    extractElectronArchive(zipPath, extractDir)
    const extractedExecutable = resolve(extractDir, platformPath)
    if (!existsSync(extractedExecutable)) {
      console.error('[electron-package] Electron archive extract did not contain executable.')
      console.error(`  platformPath=${platformPath}`)
      console.error(`  extractDir=${extractDir}`)
      console.error(`  extractEntries=${safeReaddir(extractDir).join(', ')}`)
      process.exit(1)
    }

    moveExtractedElectronDist(extractDir, electronDistDir)

    const srcTypeDefPath = resolve(electronDistDir, 'electron.d.ts')
    if (existsSync(srcTypeDefPath)) {
      renameSync(srcTypeDefPath, resolve(electronPackageDir, 'electron.d.ts'))
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

async function downloadElectronArtifactWithRetry(downloadOptions) {
  const retryDelays = getDownloadRetryDelays()

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await downloadArtifact(downloadOptions)
    } catch (error) {
      const retryDelay = retryDelays[attempt]
      if (retryDelay === undefined || !isTransientDownloadError(error)) {
        throw error
      }

      console.warn(
        `[electron-package] Transient Electron download failure (${formatDownloadError(error)}); ` +
          `retrying in ${retryDelay}ms (${attempt + 2}/${retryDelays.length + 1}).`
      )
      rmSync(downloadOptions.cacheRoot, { recursive: true, force: true })
      await new Promise((resolveDelay) => setTimeout(resolveDelay, retryDelay))
    }
  }
}

function getDownloadRetryDelays() {
  const configured = process.env.ORCA_ELECTRON_PACKAGE_RETRY_DELAYS_MS
  if (!configured) {
    // Why: GitHub release CDN returns intermittent 503 / HTTP2 stream refusals
    // under CI fan-out; a few short attempts still exhaust during outages.
    return [1_000, 3_000, 5_000, 10_000]
  }

  const delays = configured.split(',').map(Number)
  if (delays.some((delay) => !Number.isSafeInteger(delay) || delay < 0)) {
    throw new Error('ORCA_ELECTRON_PACKAGE_RETRY_DELAYS_MS must contain non-negative integers')
  }
  return delays
}

function isTransientDownloadError(error) {
  for (const candidate of getErrorChain(error)) {
    if (transientDownloadErrorCodes.has(candidate?.code)) {
      return true
    }
    const statusCode = getDownloadErrorStatusCode(candidate)
    if (
      statusCode === 408 ||
      statusCode === 425 ||
      statusCode === 429 ||
      (statusCode >= 500 && statusCode < 600)
    ) {
      return true
    }
  }
  return false
}

function getDownloadErrorStatusCode(error) {
  // @electron/get FetchDownloader uses Fetch Response.status; older got uses statusCode.
  return (
    error?.statusCode ?? error?.status ?? error?.response?.statusCode ?? error?.response?.status
  )
}

function getErrorChain(error) {
  const errors = []
  let candidate = error
  while (candidate && errors.length < 5) {
    errors.push(candidate)
    candidate = candidate.cause
  }
  return errors
}

function formatDownloadError(error) {
  for (const candidate of getErrorChain(error)) {
    const statusCode = getDownloadErrorStatusCode(candidate)
    if (statusCode) {
      return `HTTP ${statusCode}`
    }
    if (candidate?.code) {
      return candidate.code
    }
  }
  return error instanceof Error ? error.message : String(error)
}

function extractElectronArchive(zipPath, extractDir) {
  mkdirSync(extractDir, { recursive: true })
  // Why: extract-zip/Electron install.js can leave Node 24 with an unsettled
  // promise and no active handles on CI. Host unzip tools fail synchronously.
  const command = getExtractorCommand(zipPath, extractDir)
  const result = spawnSync(command.file, command.args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })

  if (result.error) {
    throw result.error
  }
  if (result.status !== 0) {
    throw new Error(formatExtractorFailure(command, result))
  }
}

function moveExtractedElectronDist(extractDir, electronDistDir) {
  rmSync(electronDistDir, { recursive: true, force: true })
  try {
    // Why: macOS Electron archives rely on framework symlinks. Moving the
    // verified tree preserves them exactly; copying has broken them in CI.
    renameSync(extractDir, electronDistDir)
  } catch (/** @type {any} */ err) {
    if (err?.code !== 'EXDEV') {
      throw err
    }
    cpSync(extractDir, electronDistDir, {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true
    })
  }
}

function getExtractorCommand(zipPath, extractDir) {
  if (process.env.ORCA_ELECTRON_PACKAGE_EXTRACTOR) {
    return {
      file: process.execPath,
      args: [process.env.ORCA_ELECTRON_PACKAGE_EXTRACTOR, zipPath, extractDir],
      label: `node ${process.env.ORCA_ELECTRON_PACKAGE_EXTRACTOR}`
    }
  }

  if (osPlatform() === 'win32') {
    return {
      file: process.env.ORCA_POWERSHELL_BIN || 'powershell',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        [
          "$ErrorActionPreference = 'Stop'",
          `Expand-Archive -LiteralPath ${quotePowerShellLiteral(zipPath)} -DestinationPath ${quotePowerShellLiteral(extractDir)} -Force`
        ].join('; ')
      ],
      label: 'powershell Expand-Archive'
    }
  }

  return {
    file: process.env.ORCA_UNZIP_BIN || 'unzip',
    args: ['-q', zipPath, '-d', extractDir],
    label: 'unzip'
  }
}

function quotePowerShellLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

function formatExtractorFailure(command, result) {
  return [
    `[electron-package] ${command.label} failed with status ${result.status}.`,
    result.stdout ? `stdout:\n${result.stdout.trim()}` : '',
    result.stderr ? `stderr:\n${result.stderr.trim()}` : ''
  ]
    .filter(Boolean)
    .join('\n')
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

function getElectronTargetPlatform() {
  return process.env.ELECTRON_INSTALL_PLATFORM || process.env.npm_config_platform || osPlatform()
}

function getElectronTargetArch() {
  return process.env.ELECTRON_INSTALL_ARCH || process.env.npm_config_arch || process.arch
}

function getElectronPlatformPath(targetPlatform) {
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
