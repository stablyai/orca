import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import {
  recoverAndScavengeRuntimePaths,
  withRuntimePublicationLock
} from './wsl-watcher-runtime-publication.mjs'

const DEFAULT_MAX_COMPLETED_BUILDS = 5
const DEFAULT_MIN_RECENT_BUILDS = 2
const DEFAULT_MAX_BUILD_AGE_MS = 7 * 24 * 60 * 60 * 1_000
const DEFAULT_UNKNOWN_LEASE_AGE_MS = 24 * 60 * 60 * 1_000
const BUILD_VERSION_RE = /^[a-f0-9]{20}$/
const defaultOperations = { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile }
const execFileAsync = promisify(execFile)

function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex')
}

async function isFile(filename, operations) {
  try {
    return (await operations.stat(filename)).isFile()
  } catch {
    return false
  }
}

async function computedBundleVersion(bundlePath, architectures, manifest, operations) {
  const versionParts = [
    String(manifest.installLayout),
    manifest.nodeVersion,
    sha256(await operations.readFile(join(bundlePath, 'host.js'))),
    sha256(await operations.readFile(join(bundlePath, 'parcel-watcher-LICENSE')))
  ]
  for (const arch of architectures) {
    versionParts.push(
      arch,
      sha256(await operations.readFile(join(bundlePath, arch, 'node.tar.xz'))),
      sha256(await operations.readFile(join(bundlePath, arch, 'watcher.node')))
    )
  }
  return sha256(versionParts.join('\n')).slice(0, 20)
}

export async function validatePreparedRuntimeBundle(
  bundlePath,
  architectures,
  expectedManifest,
  { operations: operationOverrides = {} } = {}
) {
  const operations = { ...defaultOperations, ...operationOverrides }
  let manifest
  try {
    manifest = JSON.parse(await operations.readFile(join(bundlePath, 'manifest.json'), 'utf8'))
  } catch {
    return false
  }
  if (
    manifest?.protocol !== 1 ||
    manifest.installLayout !== 1 ||
    typeof manifest.nodeVersion !== 'string' ||
    !BUILD_VERSION_RE.test(manifest.bundleVersion) ||
    (expectedManifest && JSON.stringify(manifest) !== JSON.stringify(expectedManifest))
  ) {
    return false
  }
  const required = ['host.js', 'parcel-watcher-LICENSE']
  for (const arch of architectures) {
    required.push(join(arch, 'node.tar.xz'), join(arch, 'watcher.node'))
  }
  if (
    !(await Promise.all(required.map((name) => isFile(join(bundlePath, name), operations)))).every(
      Boolean
    )
  ) {
    return false
  }
  try {
    // Why: the manifest names the content address; existence checks alone let
    // a corrupted prior build be silently reused by a later packager.
    return (
      (await computedBundleVersion(bundlePath, architectures, manifest, operations)) ===
      manifest.bundleVersion
    )
  } catch {
    return false
  }
}

export function runtimeBuildPointerPath(runtimeOutputDir) {
  return `${runtimeOutputDir}.current.json`
}

function pointerContents(runtimeOutputDir, manifest) {
  return {
    protocol: 1,
    bundleVersion: manifest.bundleVersion,
    relativePath: `${basename(runtimeOutputDir)}.builds/${manifest.bundleVersion}`
  }
}

export async function publishRuntimeBuildPointer(
  runtimeOutputDir,
  immutablePath,
  manifest,
  publicationId,
  { operations: operationOverrides = {} } = {}
) {
  const operations = { ...defaultOperations, ...operationOverrides }
  const expectedPath = join(`${runtimeOutputDir}.builds`, manifest.bundleVersion)
  if (immutablePath !== expectedPath) {
    throw new Error(`Invalid immutable WSL runtime source: ${immutablePath}`)
  }
  const pointerPath = runtimeBuildPointerPath(runtimeOutputDir)
  const pointerStage = `${pointerPath}.stage-${publicationId}`
  try {
    await operations.writeFile(
      pointerStage,
      `${JSON.stringify(pointerContents(runtimeOutputDir, manifest), null, 2)}\n`
    )
    // Why: readers see either the complete old pointer or complete new pointer;
    // both reference immutable directories that retention keeps available.
    await operations.rename(pointerStage, pointerPath)
  } finally {
    await operations.rm(pointerStage, { force: true })
  }
  return pointerPath
}

async function readCurrentBuildVersion(runtimeOutputDir, operations) {
  try {
    const pointer = JSON.parse(
      await operations.readFile(runtimeBuildPointerPath(runtimeOutputDir), 'utf8')
    )
    return pointer?.protocol === 1 && BUILD_VERSION_RE.test(pointer.bundleVersion)
      ? pointer.bundleVersion
      : null
  } catch {
    return null
  }
}

export async function runtimeProcessStartToken(pid) {
  try {
    if (process.platform === 'linux') {
      const contents = await readFile(`/proc/${pid}/stat`, 'utf8')
      return contents.slice(contents.lastIndexOf(') ') + 2).split(' ')[19] ?? null
    }
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`
        ],
        { encoding: 'utf8', timeout: 2_000, windowsHide: true }
      )
      return stdout.trim() || null
    }
    const { stdout } = await execFileAsync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 2_000
    })
    return stdout.trim() || null
  } catch {
    return null
  }
}

async function defaultLeaseOwnerIsAlive(owner) {
  try {
    process.kill(owner.pid, 0)
  } catch (error) {
    if (error?.code !== 'EPERM') {
      return false
    }
  }
  const actualStartToken = await runtimeProcessStartToken(owner.pid)
  if (!actualStartToken || typeof owner.processStartToken !== 'string') {
    return null
  }
  return actualStartToken === owner.processStartToken
}

async function activeLeaseVersions(buildsDir, names, operations, options) {
  const active = new Set()
  const leasePattern = /^([a-f0-9]{20})\.lease-/
  for (const name of names) {
    const version = name.match(leasePattern)?.[1]
    if (!version) {
      continue
    }
    const leasePath = join(buildsDir, name)
    let owner
    let modifiedAt = 0
    try {
      modifiedAt = (await operations.stat(leasePath)).mtimeMs
    } catch {}
    try {
      owner = JSON.parse(await operations.readFile(join(leasePath, 'owner.json'), 'utf8'))
    } catch {}
    const alive = Number.isSafeInteger(owner?.pid) ? await options.ownerIsAlive(owner) : null
    if (
      alive === true ||
      (alive === null && options.now() - modifiedAt < options.unknownLeaseAgeMs)
    ) {
      active.add(version)
    } else {
      await operations.rm(leasePath, { recursive: true, force: true })
    }
  }
  return active
}

export async function pruneImmutableRuntimeBuilds(
  runtimeOutputDir,
  {
    operations: operationOverrides = {},
    maxCompletedBuilds = DEFAULT_MAX_COMPLETED_BUILDS,
    minRecentBuilds = DEFAULT_MIN_RECENT_BUILDS,
    maxBuildAgeMs = DEFAULT_MAX_BUILD_AGE_MS,
    unknownLeaseAgeMs = DEFAULT_UNKNOWN_LEASE_AGE_MS,
    ownerIsAlive = defaultLeaseOwnerIsAlive,
    now = Date.now
  } = {}
) {
  const operations = { ...defaultOperations, ...operationOverrides }
  const buildsDir = `${runtimeOutputDir}.builds`
  let names
  try {
    names = await operations.readdir(buildsDir)
  } catch {
    return
  }
  const activeVersions = await activeLeaseVersions(buildsDir, names, operations, {
    now,
    ownerIsAlive,
    unknownLeaseAgeMs
  })
  const currentVersion = await readCurrentBuildVersion(runtimeOutputDir, operations)
  const builds = (
    await Promise.all(
      names
        .filter((name) => BUILD_VERSION_RE.test(name))
        .map(async (name) => {
          try {
            return { name, modifiedAt: (await operations.stat(join(buildsDir, name))).mtimeMs }
          } catch {
            return null
          }
        })
    )
  )
    .filter(Boolean)
    .sort((left, right) => right.modifiedAt - left.modifiedAt)
  let retainedCompleted = 0
  for (const [index, build] of builds.entries()) {
    const protectedBuild =
      build.name === currentVersion || activeVersions.has(build.name) || index < minRecentBuilds
    const withinAge = now() - build.modifiedAt < maxBuildAgeMs
    if (protectedBuild || (retainedCompleted < maxCompletedBuilds && withinAge)) {
      if (!activeVersions.has(build.name)) {
        retainedCompleted += 1
      }
      continue
    }
    await operations.rm(join(buildsDir, build.name), { recursive: true, force: true })
  }
}

export async function acquireRuntimeBuildLease(
  immutablePath,
  {
    operations: operationOverrides = {},
    createToken = randomUUID,
    ownerProcessId = process.pid,
    ownerProcessStartToken,
    readProcessStartToken = runtimeProcessStartToken,
    now = Date.now
  } = {}
) {
  const operations = { ...defaultOperations, ...operationOverrides }
  const version = basename(immutablePath)
  if (!BUILD_VERSION_RE.test(version)) {
    throw new Error(`Cannot lease invalid WSL runtime build source: ${immutablePath}`)
  }
  const claimedStartToken = ownerProcessStartToken ?? (await readProcessStartToken(ownerProcessId))
  const actualStartToken = await readProcessStartToken(ownerProcessId)
  if (!claimedStartToken || actualStartToken !== claimedStartToken) {
    throw new Error(`Cannot verify WSL runtime build lease owner: ${ownerProcessId}`)
  }
  const leasePath = join(dirname(immutablePath), `${version}.lease-${createToken()}`)
  try {
    await operations.mkdir(leasePath)
    await operations.writeFile(
      join(leasePath, 'owner.json'),
      `${JSON.stringify({
        protocol: 1,
        pid: ownerProcessId,
        processStartToken: claimedStartToken,
        createdAt: now()
      })}\n`
    )
    return leasePath
  } catch (error) {
    await operations.rm(leasePath, { recursive: true, force: true })
    throw error
  }
}

export async function createImmutableRuntimeBuildSource(
  sourceStage,
  runtimeOutputDir,
  manifest,
  architectures,
  publicationId,
  {
    operations: operationOverrides = {},
    lockOptions = {},
    retentionOptions = {},
    afterBuildSourceLockAcquired
  } = {}
) {
  const operations = { ...defaultOperations, ...operationOverrides }
  const buildsDir = `${runtimeOutputDir}.builds`
  const immutablePath = join(buildsDir, manifest.bundleVersion)
  const immutableStage = `${immutablePath}.stage-${publicationId}`
  const lockPath = `${runtimeOutputDir}.builds.publish.lock`
  const validate = (candidate) =>
    validatePreparedRuntimeBundle(candidate, architectures, manifest, { operations })
  await operations.mkdir(buildsDir, { recursive: true })
  try {
    await operations.rm(immutableStage, { recursive: true, force: true })
    await operations.cp(sourceStage, immutableStage, { recursive: true, force: false })
    await withRuntimePublicationLock(
      lockPath,
      async () => {
        await afterBuildSourceLockAcquired?.({ immutablePath, immutableStage })
        await recoverAndScavengeRuntimePaths(immutablePath, validate, { operations })
        if (!(await validate(immutableStage))) {
          throw new Error(`Prepared WSL runtime stage failed content validation: ${immutableStage}`)
        }
        if (!(await validate(immutablePath))) {
          await operations.rm(immutablePath, { recursive: true, force: true })
          await operations.rename(immutableStage, immutablePath)
        }
        await pruneImmutableRuntimeBuilds(runtimeOutputDir, {
          ...retentionOptions,
          operations
        })
      },
      { ...lockOptions, operations }
    )
    return immutablePath
  } finally {
    await operations.rm(immutableStage, { recursive: true, force: true })
  }
}
