import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { lstat, readlink, readdir, rename, rm, rmdir, symlink, unlink } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { APPIMAGE_SOURCE_RECORD_NAME } from '../../shared/appimage-cache-identity'
import { isAppImageCacheKey, resolveCachedAppImagePayloadRoot } from './appimage-cache-layout'
import { inspectAppImageGenerationLeases } from './appimage-generation-lease'
import { residencyOfGeneration, scanResidentExecutables } from './appimage-generation-residency'
import type { ResidentExecutableScan } from './appimage-generation-residency'
import { removeExtractedAppImagePayload } from './appimage-payload-removal'
import {
  removeAppImageLegacyLiveEndpoint,
  resolveAppImageLauncherEndpointPath
} from './appimage-stable-launcher'

const EXTRACTION_STAGING_PREFIX = '.extract-'
const ACTIVE_EXTRACTION_PREFIX = '.active-'
export const APPIMAGE_EXTRACTION_TIMEOUT_MS = 300_000
// Cross-process extractors are bounded at five minutes; retain a second window before cleanup.
const STALE_EXTRACTION_GRACE_MS = APPIMAGE_EXTRACTION_TIMEOUT_MS * 2

const activeExtractionPaths = new Set<string>()

export function trackAppImageExtraction(stagingPath: string): () => void {
  activeExtractionPaths.add(stagingPath)
  return () => activeExtractionPaths.delete(stagingPath)
}

export function getAppImageActiveExtractionPath(rootPath: string): string {
  return join(dirname(rootPath), `${ACTIVE_EXTRACTION_PREFIX}${basename(rootPath)}`)
}

/** Prunes idle generations beside `keepRootPath`, and in `legacyNamespacePath` when given. */
export async function pruneAppImageExtractedRoots(
  keepRootPath: string,
  legacyNamespacePath?: string
): Promise<void> {
  const resolvedKeepRoot = resolve(keepRootPath)
  const namespacePath = dirname(resolvedKeepRoot)
  const cacheRootPath = dirname(namespacePath)
  const installedRoot = await resolveInstalledRoot(cacheRootPath)
  const namespaces = legacyNamespacePath
    ? [namespacePath, resolve(legacyNamespacePath)]
    : [namespacePath]
  for (const candidateNamespace of namespaces) {
    const protectedRoots = new Set([resolvedKeepRoot])
    if (installedRoot && dirname(installedRoot) === candidateNamespace) {
      protectedRoots.add(installedRoot)
    }
    await pruneNamespace(cacheRootPath, candidateNamespace, protectedRoots)
    await rmdir(candidateNamespace).catch(() => {})
  }
}

export async function removeAppImageInstalledPayloads(namespacePath: string): Promise<void> {
  const resolvedNamespace = resolve(namespacePath)
  const cacheRootPath = dirname(resolvedNamespace)
  removeAppImageLegacyLiveEndpoint(cacheRootPath)
  if (await removeInstalledEndpoint(cacheRootPath, resolvedNamespace)) {
    await pruneNamespace(cacheRootPath, resolvedNamespace, new Set())
    await rm(join(resolvedNamespace, APPIMAGE_SOURCE_RECORD_NAME), { force: true }).catch(() => {})
    await rmdir(resolvedNamespace).catch(() => {})
  }
}

async function resolveInstalledRoot(cacheRootPath: string): Promise<string | null> {
  const endpointPath = resolveAppImageLauncherEndpointPath(cacheRootPath, 'installed')
  try {
    const targetPath = resolve(dirname(endpointPath), await readlink(endpointPath))
    return resolveCachedAppImagePayloadRoot(cacheRootPath, targetPath)
  } catch {
    return null
  }
}

async function removeInstalledEndpoint(
  cacheRootPath: string,
  namespacePath: string
): Promise<boolean> {
  const endpointPath = resolveAppImageLauncherEndpointPath(cacheRootPath, 'installed')
  if (!(await endpointTargetsNamespace(cacheRootPath, endpointPath, namespacePath))) {
    return true
  }

  const displacedPath = join(
    dirname(endpointPath),
    `.orca-preserved-installed-${process.pid}-${randomUUID()}`
  )
  try {
    await rename(endpointPath, displacedPath)
  } catch {
    return !(await endpointTargetsNamespace(cacheRootPath, endpointPath, namespacePath))
  }

  if (await endpointTargetsNamespace(cacheRootPath, displacedPath, namespacePath)) {
    await unlink(displacedPath).catch(() => {})
    return true
  }

  try {
    await symlink(await readlink(displacedPath), endpointPath)
    await unlink(displacedPath)
  } catch {}
  return !(await endpointTargetsNamespace(cacheRootPath, endpointPath, namespacePath))
}

async function endpointTargetsNamespace(
  cacheRootPath: string,
  endpointPath: string,
  namespacePath: string
): Promise<boolean> {
  try {
    const targetPath = resolve(dirname(endpointPath), await readlink(endpointPath))
    const targetRoot = resolveCachedAppImagePayloadRoot(cacheRootPath, targetPath)
    return targetRoot !== null && dirname(targetRoot) === namespacePath
  } catch {
    return false
  }
}

async function pruneNamespace(
  cacheRootPath: string,
  namespacePath: string,
  protectedRoots: ReadonlySet<string>
): Promise<void> {
  let entries: Dirent[]
  try {
    entries = await readdir(namespacePath, { withFileTypes: true })
  } catch {
    return
  }
  let residentScan: ResidentExecutableScan | null = null

  for (const entry of entries) {
    const entryPath = join(namespacePath, entry.name)
    if (
      entry.name.startsWith(EXTRACTION_STAGING_PREFIX) ||
      entry.name.startsWith(ACTIVE_EXTRACTION_PREFIX)
    ) {
      if (activeExtractionPaths.has(entryPath) || !(await isOlderThanGrace(entryPath))) {
        continue
      }
    } else if (!isAppImageCacheKey(entry.name)) {
      continue
    } else if (
      protectedRoots.has(resolve(entryPath)) ||
      (existsSync(getAppImageActiveExtractionPath(entryPath)) &&
        !(await isOlderThanGrace(getAppImageActiveExtractionPath(entryPath))))
    ) {
      continue
    }
    residentScan ??= scanResidentExecutables()
    if (await isGenerationInUse(cacheRootPath, entryPath, residentScan)) {
      continue
    }
    // Best effort, but never silent: a swallowed failure here leaks a whole payload generation.
    await removeExtractedAppImagePayload(entryPath).catch((error: unknown) => {
      console.warn(
        `[cli] could not reclaim AppImage payload ${entryPath}:`,
        error instanceof Error ? error.message : error
      )
    })
  }
}

// Deletes only on positive proof of idleness: an unverifiable lease or process keeps the root.
async function isGenerationInUse(
  cacheRootPath: string,
  rootPath: string,
  residentScan: ResidentExecutableScan
): Promise<boolean> {
  const resident = residencyOfGeneration(residentScan, rootPath)
  if (resident.status !== 'exited') {
    return true
  }
  return (await inspectAppImageGenerationLeases(cacheRootPath, rootPath)).status !== 'exited'
}

async function isOlderThanGrace(candidatePath: string): Promise<boolean> {
  try {
    return Date.now() - (await lstat(candidatePath)).mtimeMs >= STALE_EXTRACTION_GRACE_MS
  } catch {
    return true
  }
}
