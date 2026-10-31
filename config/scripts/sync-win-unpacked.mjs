import { createRequire } from 'node:module'
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  renameSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { finished } from 'node:stream/promises'
import { createPackageWithOptions, extractAll } from '@electron/asar'

const require = createRequire(import.meta.url)
const { verifyPackagedDaemonEntryBoots } = require('./verify-packaged-daemon-entry.cjs')

const UNPACKED_OUT_DIRS = ['cli', 'main', 'mobile-web', 'shared', 'web']

// Why: electron-builder's `files` globs drop these out/ paths; copying out/ raw would pack them again.
export function shouldPackOutPath(relFromOut) {
  const normalized = relFromOut.replaceAll('\\', '/').replace(/^\.\//, '')
  if (normalized === '' || normalized === '.') {
    return true
  }
  const parts = normalized.split('/')
  const top = parts[0]
  if (top === 'orcad' || top.startsWith('orcad-') || top.startsWith('.orcad-')) {
    return false
  }
  if (
    top === 'runtimes' ||
    top === 'node-runtime-cache' ||
    top === 'electron-dev' ||
    top === 'relay'
  ) {
    return false
  }
  if (top === 'renderer' && parts[1] === '.vite') {
    return false
  }
  const base = parts[parts.length - 1]
  return !base.endsWith('.map') && !base.endsWith('.test.js')
}

function copyPackableOut(sourceOut, destOut) {
  cpSync(sourceOut, destOut, {
    recursive: true,
    filter(source) {
      const rel = relative(sourceOut, source)
      return rel === '' || shouldPackOutPath(rel)
    }
  })
}

function withPackableOut(sourceOut, use) {
  const parent = mkdtempSync(join(tmpdir(), 'sync-win-unpacked-out-'))
  const filtered = join(parent, 'out')
  try {
    copyPackableOut(sourceOut, filtered)
    return use(filtered)
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
}

function assertBuiltDaemonEntry(repoRoot) {
  const entryPath = join(repoRoot, 'out', 'main', 'daemon-entry.js')
  if (!existsSync(entryPath)) {
    throw new Error(
      `[sync-win-unpacked] missing ${entryPath}; run pnpm run build:desktop:assets first`
    )
  }
}

function installedResourcesDir() {
  const localAppData = process.env.LOCALAPPDATA
  if (!localAppData) {
    return null
  }
  const resourcesDir = join(localAppData, 'Programs', 'orca', 'resources')
  return existsSync(resourcesDir) ? resourcesDir : null
}

function replaceError(error, destPath) {
  const code = error && typeof error === 'object' ? error.code : undefined
  if (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') {
    return new Error(
      `[sync-win-unpacked] could not replace ${destPath} (${code}); close Orca and retry`,
      { cause: error }
    )
  }
  return error
}

function restoreMovedDest(dest, backupPath, movedDest) {
  if (movedDest && !existsSync(dest) && existsSync(backupPath)) {
    try {
      renameSync(backupPath, dest)
    } catch {
      // Leave the backup in place when the rollback rename fails.
    }
  }
}

function removeStaging(stagingPath) {
  try {
    rmSync(stagingPath, { recursive: true, force: true })
  } catch {
    // Preserve the original failure.
  }
}

// Why: a failed rollback can leave `.bak` as the only copy of the previous tree.
function prepareBackupPath(destPath, backupPath) {
  if (!existsSync(backupPath)) {
    return
  }
  if (!existsSync(destPath)) {
    renameSync(backupPath, destPath)
  }
  if (existsSync(destPath) && existsSync(backupPath)) {
    throw new Error(
      `[sync-win-unpacked] leftover backup exists at ${backupPath}; restore or remove it before syncing`
    )
  }
}

// Why: a later copy or verify failure must restore every replacement together.
export function createPublishTransaction() {
  const retained = []
  return {
    retain(destPath, backupPath) {
      retained.push({ destPath, backupPath })
    },
    rollback() {
      for (let index = retained.length - 1; index >= 0; index -= 1) {
        const { destPath, backupPath } = retained[index]
        try {
          rmSync(destPath, { recursive: true, force: true })
          if (backupPath && existsSync(backupPath)) {
            renameSync(backupPath, destPath)
          }
        } catch (error) {
          // Keep restoring earlier replacements, but report each failed restore.
          const message = error instanceof Error ? error.message : String(error)
          console.error(`[sync-win-unpacked] rollback failed for ${destPath}: ${message}`)
          if (backupPath) {
            console.error(`[sync-win-unpacked] previous contents may remain at ${backupPath}`)
          }
        }
      }
      retained.length = 0
    },
    commit() {
      for (const { backupPath } of retained) {
        if (backupPath) {
          rmSync(backupPath, { recursive: true, force: true })
        }
      }
      retained.length = 0
    }
  }
}

export function replaceDirectory(dest, source, transaction) {
  const stagingPath = `${dest}.new`
  const backupPath = `${dest}.bak`
  rmSync(stagingPath, { recursive: true, force: true })
  prepareBackupPath(dest, backupPath)
  let movedDest = false
  try {
    cpSync(source, stagingPath, { recursive: true })
    if (existsSync(dest)) {
      renameSync(dest, backupPath)
      movedDest = true
    }
    renameSync(stagingPath, dest)
  } catch (error) {
    restoreMovedDest(dest, backupPath, movedDest)
    removeStaging(stagingPath)
    throw replaceError(error, dest)
  }
  if (transaction) {
    transaction.retain(dest, movedDest ? backupPath : null)
    return
  }
  rmSync(backupPath, { recursive: true, force: true })
}

function replaceFileAtomically(stagingPath, destPath, transaction) {
  const backupPath = `${destPath}.bak`
  prepareBackupPath(destPath, backupPath)
  let movedDest = false
  try {
    if (existsSync(destPath)) {
      renameSync(destPath, backupPath)
      movedDest = true
    }
    renameSync(stagingPath, destPath)
  } catch (error) {
    restoreMovedDest(destPath, backupPath, movedDest)
    removeStaging(stagingPath)
    throw replaceError(error, destPath)
  }
  if (transaction) {
    transaction.retain(destPath, movedDest ? backupPath : null)
    return
  }
  rmSync(backupPath, { force: true })
}

export function publishFile(transaction, sourcePath, destPath) {
  const stagingPath = `${destPath}.new`
  rmSync(stagingPath, { force: true })
  try {
    copyFileSync(sourcePath, stagingPath)
    replaceFileAtomically(stagingPath, destPath, transaction)
  } catch (error) {
    removeStaging(stagingPath)
    throw error
  }
}

function syncUnpackedOut(resourcesDir, repoRoot) {
  const sourceOut = join(repoRoot, 'out')
  const destOut = join(resourcesDir, 'app.asar.unpacked', 'out')
  mkdirSync(destOut, { recursive: true })
  for (const name of UNPACKED_OUT_DIRS) {
    const source = join(sourceOut, name)
    if (!existsSync(source)) {
      throw new Error(
        `[sync-win-unpacked] missing ${source}; run pnpm run build:desktop:assets first`
      )
    }
  }
  const packageJsonPath = join(sourceOut, 'package.json')
  if (!existsSync(packageJsonPath)) {
    throw new Error(
      `[sync-win-unpacked] missing ${packageJsonPath}; run pnpm run build:desktop:assets first`
    )
  }
  withPackableOut(sourceOut, (filtered) => {
    for (const name of UNPACKED_OUT_DIRS) {
      replaceDirectory(join(destOut, name), join(filtered, name))
    }
    copyFileSync(packageJsonPath, join(destOut, 'package.json'))
  })
}

function syncProcessHost(resourcesDir, repoRoot) {
  const sourceRoot = join(repoRoot, 'node_modules', '@orca', 'process-host')
  const sourcePackageJson = join(sourceRoot, 'package.json')
  const sourceDist = join(sourceRoot, 'dist')
  if (!existsSync(sourcePackageJson) || !existsSync(sourceDist)) {
    throw new Error(
      `[sync-win-unpacked] missing ${sourceRoot}; run pnpm run build:desktop:assets first`
    )
  }
  const destRoot = join(resourcesDir, 'node_modules', '@orca', 'process-host')
  const destDist = join(destRoot, 'dist')
  mkdirSync(destRoot, { recursive: true })
  copyFileSync(sourcePackageJson, join(destRoot, 'package.json'))
  rmSync(destDist, { recursive: true, force: true })
  mkdirSync(destDist, { recursive: true })
  for (const name of readdirSync(sourceDist)) {
    if (name.endsWith('.js')) {
      copyFileSync(join(sourceDist, name), join(destDist, name))
    }
  }
}

function asarUnpackGlob(sourceDir) {
  const { asarUnpack } = require('../electron-builder.config.cjs')
  if (!Array.isArray(asarUnpack) || asarUnpack.length === 0) {
    throw new Error('[sync-win-unpacked] electron-builder asarUnpack is empty')
  }
  // Why: @electron/asar unpack is one minimatch, and brace expansion is how it takes many patterns.
  return `{${asarUnpack.map((pattern) => join(sourceDir, pattern).split(sep).join('/')).join(',')}}`
}

// Why: createPackage resolves when end() is called, before the archive bytes are flushed.
export async function repackExtractedApp(sourceDir, archivePath) {
  await finished(
    await createPackageWithOptions(sourceDir, archivePath, {
      unpack: asarUnpackGlob(sourceDir)
    })
  )
}

export function publishStagedResources(transaction, stagingResources, resourcesDir) {
  const destAsar = join(resourcesDir, 'app.asar')
  if (existsSync(destAsar)) {
    publishFile(transaction, join(stagingResources, 'app.asar'), destAsar)
  }
  // Why: shipping only out/ would drop unpacked resources the new header still points at.
  replaceDirectory(
    join(resourcesDir, 'app.asar.unpacked'),
    join(stagingResources, 'app.asar.unpacked'),
    transaction
  )
  const stagingHost = join(stagingResources, 'node_modules', '@orca', 'process-host')
  const destHost = join(resourcesDir, 'node_modules', '@orca', 'process-host')
  mkdirSync(destHost, { recursive: true })
  publishFile(transaction, join(stagingHost, 'package.json'), join(destHost, 'package.json'))
  replaceDirectory(join(destHost, 'dist'), join(stagingHost, 'dist'), transaction)
}

function replacePackableOut(dest, sourceOut, transaction) {
  withPackableOut(sourceOut, (filtered) => {
    replaceDirectory(dest, filtered, transaction)
  })
}

export async function stageFilteredOut(repoRoot, extractDir, stagingResources) {
  replacePackableOut(join(extractDir, 'out'), join(repoRoot, 'out'))
  mkdirSync(stagingResources, { recursive: true })
  await repackExtractedApp(extractDir, join(stagingResources, 'app.asar'))
  syncUnpackedOut(stagingResources, repoRoot)
}

async function stageResources(repoRoot, extractDir, stagingResources, distAsar) {
  rmSync(extractDir, { recursive: true, force: true })
  rmSync(stagingResources, { recursive: true, force: true })
  extractAll(distAsar, extractDir)
  await stageFilteredOut(repoRoot, extractDir, stagingResources)
  syncProcessHost(stagingResources, repoRoot)
  verifyPackagedDaemonEntryBoots(stagingResources)
}

async function main() {
  const repoRoot = resolve(import.meta.dirname, '../..')
  assertBuiltDaemonEntry(repoRoot)
  const distResources = join(repoRoot, 'dist', 'win-unpacked', 'resources')
  const distAsar = join(distResources, 'app.asar')
  if (!existsSync(distAsar)) {
    throw new Error(`[sync-win-unpacked] missing ${distAsar}`)
  }
  const extractDir = join(repoRoot, 'tmp', `asar-sync-${process.pid}`)
  const stagingResources = join(repoRoot, 'tmp', `win-unpacked-stage-${process.pid}`)
  const installedResources = installedResourcesDir()
  const transaction = createPublishTransaction()
  let committed = false
  try {
    await stageResources(repoRoot, extractDir, stagingResources, distAsar)
    const targets = installedResources ? [distResources, installedResources] : [distResources]
    for (const resourcesDir of targets) {
      publishStagedResources(transaction, stagingResources, resourcesDir)
      verifyPackagedDaemonEntryBoots(resourcesDir)
    }
    committed = true
  } catch (error) {
    transaction.rollback()
    throw error
  } finally {
    try {
      if (committed) {
        transaction.commit()
      }
    } finally {
      rmSync(extractDir, { recursive: true, force: true })
      rmSync(stagingResources, { recursive: true, force: true })
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
