import { existsSync, readFileSync } from 'node:fs'
import { access, readFile } from 'node:fs/promises'
import { join, win32 as winPath } from 'node:path'
import {
  buildDaemonHostManifest,
  daemonHostProcessPackageDir,
  daemonHostWindowsRegistryDir,
  WINDOWS_REGISTRY_REQUIRED,
  destPath,
  toPosixRelative,
  type DaemonHostSources
} from './daemon-host-manifest'
import { mapWithConcurrencyUntilFailure } from '../../../../shared/concurrency/map-with-concurrency'
import { DAEMON_HOST_FS_CONCURRENCY } from './daemon-host-tree-walk'

export type CodeFileSource = { sourcePath: string; destRel: string }

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isSafeRelativePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    !value.includes('\\') &&
    !value.includes(':') &&
    value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
  )
}

/** Export targets of the process-host package; null when its manifest is not a valid runtime. */
function processHostExportPaths(manifestText: string, packageDir: string): string[] | null {
  const manifest: unknown = JSON.parse(manifestText)
  if (
    !isRecord(manifest) ||
    manifest.name !== '@orca/process-host' ||
    !isRecord(manifest.exports)
  ) {
    return null
  }
  const paths: string[] = []
  for (const entry of Object.values(manifest.exports)) {
    if (!isRecord(entry) || typeof entry.default !== 'string') {
      return null
    }
    const relative = entry.default.startsWith('./') ? entry.default.slice(2) : entry.default
    if (!isSafeRelativePath(relative) || !relative.startsWith('dist/')) {
      return null
    }
    paths.push(destPath(packageDir, relative))
  }
  return paths.length > 0 ? paths : null
}

type InventoryPlan = {
  /** Every path that must exist before the install can host a relocated daemon. */
  required: string[]
  processHostManifest: string
  processHostDir: string
  roots: CodeFileSource[]
  /** Roots included only when present. */
  optional: CodeFileSource[]
}

function inventoryPlan(sources: DaemonHostSources): InventoryPlan {
  const processHostDir = daemonHostProcessPackageDir(sources)
  const packageRel = toPosixRelative(sources.appDir, processHostDir)
  const registryDir = daemonHostWindowsRegistryDir(sources)
  const registryRel = toPosixRelative(sources.appDir, registryDir)
  const chunksDir = join(winPath.dirname(sources.entrySourcePath), 'chunks')
  const outManifest = join(sources.resourcesPath, 'app.asar.unpacked', 'out', 'package.json')
  return {
    required: buildDaemonHostManifest(sources)
      .filter((op) => !op.optional)
      .map((op) => op.sourcePath),
    processHostManifest: join(processHostDir, 'package.json'),
    processHostDir,
    roots: [
      { sourcePath: sources.entrySourcePath, destRel: sources.entryRelPath },
      { sourcePath: join(processHostDir, 'package.json'), destRel: `${packageRel}/package.json` },
      { sourcePath: join(processHostDir, 'dist'), destRel: `${packageRel}/dist` },
      ...WINDOWS_REGISTRY_REQUIRED.map((relative) => ({
        sourcePath: destPath(registryDir, relative),
        destRel: `${registryRel}/${relative}`
      }))
    ],
    optional: [chunksDir, outManifest].map((sourcePath) => ({
      sourcePath,
      destRel: toPosixRelative(sources.appDir, sourcePath)
    }))
  }
}

/** Code roots the fingerprint covers; null when the install cannot host a relocated daemon. */
export function inventoryRoots(sources: DaemonHostSources): CodeFileSource[] | null {
  const plan = inventoryPlan(sources)
  if (!plan.required.every(existsSync)) {
    return null
  }
  const exportPaths = processHostExportPaths(
    readFileSync(plan.processHostManifest, 'utf8'),
    plan.processHostDir
  )
  if (!exportPaths?.every(existsSync)) {
    return null
  }
  return [...plan.roots, ...plan.optional.filter((root) => existsSync(root.sourcePath))]
}

function pathExists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false
  )
}

async function allExist(paths: readonly string[]): Promise<boolean> {
  return (
    await mapWithConcurrencyUntilFailure(paths, DAEMON_HOST_FS_CONCURRENCY, pathExists)
  ).every(Boolean)
}

/** Whether a process-host package dir (an install's or a staged copy's) has every export target. */
export async function processHostExportsPresentAsync(packageDir: string): Promise<boolean> {
  const exportPaths = processHostExportPaths(
    await readFile(join(packageDir, 'package.json'), 'utf8'),
    packageDir
  )
  return exportPaths !== null && (await allExist(exportPaths))
}

export async function inventoryRootsAsync(
  sources: DaemonHostSources
): Promise<CodeFileSource[] | null> {
  const plan = inventoryPlan(sources)
  // Every fingerprint root (e.g. the registry addon) must exist, or a cold copy would publish an unusable build.
  if (!(await allExist([...plan.required, ...plan.roots.map((root) => root.sourcePath)]))) {
    return null
  }
  if (!(await processHostExportsPresentAsync(plan.processHostDir))) {
    return null
  }
  const present = await mapWithConcurrencyUntilFailure(
    plan.optional,
    DAEMON_HOST_FS_CONCURRENCY,
    (root) => pathExists(root.sourcePath)
  )
  return [...plan.roots, ...plan.optional.filter((_, index) => present[index])]
}

/**
 * Matches copy destRels under any fingerprint root, optional ones included even when absent,
 * so a root an update creates mid-copy still counts as code.
 */
export function daemonHostCodeMatcher(sources: DaemonHostSources): (destRel: string) => boolean {
  const plan = inventoryPlan(sources)
  const rels = [...plan.roots, ...plan.optional].map((root) => root.destRel)
  return (destRel) => rels.some((rel) => destRel === rel || destRel.startsWith(`${rel}/`))
}
