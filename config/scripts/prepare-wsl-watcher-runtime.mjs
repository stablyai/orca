import { createHash, randomUUID } from 'node:crypto'
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  recoverAndScavengeRuntimePaths,
  replacePublishedRuntimePath,
  withRuntimePublicationLock
} from './wsl-watcher-runtime-publication.mjs'
import {
  acquireRuntimeBuildLease,
  createImmutableRuntimeBuildSource,
  publishRuntimeBuildPointer,
  validatePreparedRuntimeBundle
} from './wsl-watcher-runtime-build-source.mjs'
import { downloadRuntimeArchive } from './wsl-watcher-runtime-cache.mjs'

export const WSL_WATCHER_NODE_VERSION = '24.15.0'
const WSL_WATCHER_INSTALL_LAYOUT_VERSION = 1

const rootDir = path.resolve(import.meta.dirname, '../..')
const outputDir = path.join(rootDir, 'out', 'wsl-watcher')
const cacheDir = path.join(rootDir, 'node_modules', '.cache', 'orca-wsl-watcher')
const runtimeArchives = {
  x64: {
    sha256: '472655581fb851559730c48763e0c9d3bc25975c59d518003fc0849d3e4ba0f6',
    watcherPackage: '@parcel/watcher-linux-x64-glibc'
  },
  arm64: {
    sha256: 'f3d5a797b5d210ce8e2cb265544c8e482eaedcb8aa409a8b46da7e8595d0dda0',
    watcherPackage: '@parcel/watcher-linux-arm64-glibc'
  }
}

function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex')
}

const defaultRuntimeFileOperations = { copyFile, mkdir, readFile, rename, rm, stat, writeFile }

export function downloadRuntime(arch, expectedHash, options = {}) {
  return downloadRuntimeArchive(arch, expectedHash, WSL_WATCHER_NODE_VERSION, cacheDir, options)
}

async function assertBuildInput(filename, description, statRuntimePath = stat) {
  try {
    const info = await statRuntimePath(filename)
    if (info.isFile()) {
      return
    }
  } catch {}
  throw new Error(`Missing ${description} at ${filename}. Run pnpm build:electron-vite first.`)
}

export async function prepareWslWatcherRuntime({
  runtimeRootDir = rootDir,
  runtimeOutputDir = outputDir,
  fetchRuntimeArchive = downloadRuntime,
  archives = runtimeArchives,
  createPublicationId = randomUUID,
  beforePublish,
  afterPublicationLockAcquired,
  runtimeFileOperations: operationOverrides = {},
  publicationLockOptions = {},
  buildRetentionOptions = {}
} = {}) {
  const operations = { ...defaultRuntimeFileOperations, ...operationOverrides }
  const hostSource = path.join(runtimeRootDir, 'out', 'main', 'wsl-watcher-host.js')
  await assertBuildInput(hostSource, 'compiled WSL watcher host', operations.stat)

  const publicationId = createPublicationId()
  const architectures = Object.keys(archives)
  const stageDir = `${runtimeOutputDir}.stage-${publicationId}`
  const backupDir = `${runtimeOutputDir}.backup-${publicationId}`
  const lockPath = `${runtimeOutputDir}.publish.lock`
  const validatePublished = (candidate) =>
    validatePreparedRuntimeBundle(candidate, architectures, undefined, { operations })
  await operations.mkdir(path.dirname(runtimeOutputDir), { recursive: true })
  await withRuntimePublicationLock(
    lockPath,
    () => recoverAndScavengeRuntimePaths(runtimeOutputDir, validatePublished, { operations }),
    { ...publicationLockOptions, operations }
  )
  try {
    await operations.rm(stageDir, { recursive: true, force: true })
    await operations.mkdir(stageDir, { recursive: true })
    const hostContents = await operations.readFile(hostSource)
    await operations.writeFile(path.join(stageDir, 'host.js'), hostContents)
    const watcherLicense = await operations.readFile(
      path.join(runtimeRootDir, 'node_modules', '@parcel', 'watcher', 'LICENSE')
    )
    await operations.writeFile(path.join(stageDir, 'parcel-watcher-LICENSE'), watcherLicense)

    const versionParts = [
      String(WSL_WATCHER_INSTALL_LAYOUT_VERSION),
      WSL_WATCHER_NODE_VERSION,
      sha256(hostContents),
      sha256(watcherLicense)
    ]
    for (const [arch, runtime] of Object.entries(archives)) {
      const archDir = path.join(stageDir, arch)
      await operations.mkdir(archDir, { recursive: true })
      const archive = await fetchRuntimeArchive(arch, runtime.sha256)
      const watcherSource = path.join(
        runtimeRootDir,
        'node_modules',
        '@parcel',
        runtime.watcherPackage.replace('@parcel/', ''),
        'watcher.node'
      )
      const watcherContents = await operations.readFile(watcherSource)
      versionParts.push(arch, runtime.sha256, sha256(watcherContents))
      await operations.copyFile(archive, path.join(archDir, 'node.tar.xz'))
      await operations.writeFile(path.join(archDir, 'watcher.node'), watcherContents)
    }

    const manifest = {
      protocol: 1,
      installLayout: WSL_WATCHER_INSTALL_LAYOUT_VERSION,
      nodeVersion: WSL_WATCHER_NODE_VERSION,
      bundleVersion: sha256(versionParts.join('\n')).slice(0, 20)
    }
    await operations.writeFile(
      path.join(stageDir, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`
    )
    const packageSourceDir = await createImmutableRuntimeBuildSource(
      stageDir,
      runtimeOutputDir,
      manifest,
      architectures,
      publicationId,
      {
        operations,
        lockOptions: publicationLockOptions,
        retentionOptions: buildRetentionOptions
      }
    )
    await beforePublish?.({ publicationId, stageDir })
    await withRuntimePublicationLock(
      lockPath,
      async () => {
        await recoverAndScavengeRuntimePaths(runtimeOutputDir, validatePublished, { operations })
        await afterPublicationLockAcquired?.({ publicationId, stageDir })
        await replacePublishedRuntimePath(stageDir, runtimeOutputDir, backupDir, {
          operations
        })
        await publishRuntimeBuildPointer(
          runtimeOutputDir,
          packageSourceDir,
          manifest,
          publicationId,
          { operations }
        )
      },
      { ...publicationLockOptions, operations }
    )
    process.stdout.write(
      `[prepare-wsl-watcher-runtime] prepared ${manifest.bundleVersion} in ${runtimeOutputDir}\n`
    )
    return { ...manifest, packageSourceDir }
  } finally {
    // Why: interrupted preparation must not leave large archives eligible for
    // app.asar discovery or consume disk indefinitely across package retries.
    await operations.rm(stageDir, { recursive: true, force: true })
  }
}

function commandLineValue(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

if (process.argv[1] === import.meta.filename) {
  const prepared = await prepareWslWatcherRuntime()
  if (process.argv.includes('--print-package-source')) {
    const ownerProcessId = Number(commandLineValue('--lease-owner-pid'))
    const ownerProcessStartToken = commandLineValue('--lease-owner-start-token')
    if (
      !Number.isSafeInteger(ownerProcessId) ||
      ownerProcessId <= 0 ||
      ownerProcessId !== process.ppid ||
      !ownerProcessStartToken
    ) {
      throw new Error('Invalid Electron Builder parent identity for WSL runtime lease')
    }
    const packageSource = path.relative(rootDir, prepared.packageSourceDir).replaceAll('\\', '/')
    const leasePath = await acquireRuntimeBuildLease(prepared.packageSourceDir, {
      ownerProcessId,
      ownerProcessStartToken
    })
    const packageLease = path.relative(rootDir, leasePath).replaceAll('\\', '/')
    process.stdout.write(`ORCA_WSL_WATCHER_BUILD_SOURCE=${packageSource}\n`)
    process.stdout.write(`ORCA_WSL_WATCHER_BUILD_LEASE=${packageLease}\n`)
  }
}
