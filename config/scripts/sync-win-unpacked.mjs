import { createRequire } from 'node:module'
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  renameSync
} from 'node:fs'
import { join, resolve } from 'node:path'
import { finished } from 'node:stream/promises'
import { createPackage, extractAll } from '@electron/asar'

const require = createRequire(import.meta.url)
const { verifyPackagedDaemonEntryBoots } = require('./verify-packaged-daemon-entry.cjs')

const UNPACKED_OUT_DIRS = ['cli', 'main', 'mobile-web', 'shared', 'web']

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

function replaceDirectory(dest, source) {
  rmSync(dest, { recursive: true, force: true })
  cpSync(source, dest, { recursive: true })
}

function replaceFileAtomically(stagingPath, destPath) {
  const backupPath = `${destPath}.bak`
  rmSync(backupPath, { force: true })
  let movedDest = false
  try {
    if (existsSync(destPath)) {
      renameSync(destPath, backupPath)
      movedDest = true
    }
    renameSync(stagingPath, destPath)
  } catch (error) {
    if (movedDest && !existsSync(destPath) && existsSync(backupPath)) {
      try {
        renameSync(backupPath, destPath)
      } catch {
        // Leave the backup in place when the rollback rename fails.
      }
    }
    const code = error && typeof error === 'object' ? error.code : undefined
    if (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') {
      throw new Error(
        `[sync-win-unpacked] could not replace ${destPath} (${code}); close Orca and retry`,
        { cause: error }
      )
    }
    throw error
  }
  rmSync(backupPath, { force: true })
}

async function publishPackedAsar(extractDir, resourcesDir) {
  const destPath = join(resourcesDir, 'app.asar')
  const stagingPath = join(resourcesDir, 'app.asar.new')
  rmSync(stagingPath, { force: true })
  // Why: createPackage resolves when end() is called, before the archive bytes are flushed.
  await finished(await createPackage(extractDir, stagingPath))
  replaceFileAtomically(stagingPath, destPath)
}

function copyPackedAsar(sourceAsar, resourcesDir) {
  const destPath = join(resourcesDir, 'app.asar')
  if (!existsSync(destPath)) {
    return
  }
  const stagingPath = join(resourcesDir, 'app.asar.new')
  rmSync(stagingPath, { force: true })
  copyFileSync(sourceAsar, stagingPath)
  replaceFileAtomically(stagingPath, destPath)
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
    replaceDirectory(join(destOut, name), source)
  }
  const packageJsonPath = join(sourceOut, 'package.json')
  if (!existsSync(packageJsonPath)) {
    throw new Error(
      `[sync-win-unpacked] missing ${packageJsonPath}; run pnpm run build:desktop:assets first`
    )
  }
  copyFileSync(packageJsonPath, join(destOut, 'package.json'))
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

async function main() {
  const repoRoot = resolve(import.meta.dirname, '../..')
  assertBuiltDaemonEntry(repoRoot)
  const distResources = join(repoRoot, 'dist', 'win-unpacked', 'resources')
  const distAsar = join(distResources, 'app.asar')
  if (!existsSync(distAsar)) {
    throw new Error(`[sync-win-unpacked] missing ${distAsar}`)
  }
  const extractDir = join(repoRoot, 'tmp', `asar-sync-${process.pid}`)
  const installedResources = installedResourcesDir()
  try {
    rmSync(extractDir, { recursive: true, force: true })
    extractAll(distAsar, extractDir)
    replaceDirectory(join(extractDir, 'out'), join(repoRoot, 'out'))
    await publishPackedAsar(extractDir, distResources)
    if (installedResources) {
      copyPackedAsar(distAsar, installedResources)
    }
    const targets = installedResources ? [distResources, installedResources] : [distResources]
    for (const resourcesDir of targets) {
      syncUnpackedOut(resourcesDir, repoRoot)
      syncProcessHost(resourcesDir, repoRoot)
      verifyPackagedDaemonEntryBoots(resourcesDir)
    }
  } finally {
    rmSync(extractDir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
