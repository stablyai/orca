import { createHash } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { access, lstat, realpath, stat } from 'node:fs/promises'
import { dirname, normalize, resolve } from 'node:path'
import type { SkillInstallationTopology } from '../../shared/skill-freshness'
import type { SkillScanRoot } from './skill-discovery-sources'

export type ClassifiedSkillTopology = {
  topology: SkillInstallationTopology
  resolvedPath: string | null
  identity: string | null
  errorCategory: string | null
}

export function skillPlacementId(unresolvedPath: string, name: string): string {
  return createHash('sha256')
    .update(normalizedSkillIdentityPath(unresolvedPath))
    .update('\0')
    .update(name)
    .digest('hex')
    .slice(0, 24)
}

export function normalizedSkillIdentityPath(value: string): string {
  const normalized = normalize(value)
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized
}

export function skillPhysicalIdentity(resolvedPath: string, fileStat: Stats): string {
  const inodeIdentity = fileStat.dev || fileStat.ino ? `${fileStat.dev}:${fileStat.ino}` : null
  return inodeIdentity ?? normalizedSkillIdentityPath(resolvedPath)
}

export function skillTopologyPriority(topology: SkillInstallationTopology): number {
  switch (topology) {
    case 'canonical-copy':
      return 3
    case 'independent-copy':
      return 2
    case 'provider-alias':
      return 1
    case 'external-link':
    case 'broken-link':
    case 'read-only':
    case 'repo-scope':
    case 'plugin-cache':
      return 0
  }
}

async function writableDestination(path: string): Promise<boolean> {
  try {
    await Promise.all([
      access(path, constants.R_OK | constants.W_OK),
      access(dirname(path), constants.W_OK)
    ])
    return true
  } catch {
    return false
  }
}

async function hasSymlinkedAncestor(path: string, boundary: string): Promise<boolean> {
  let current = resolve(path)
  const stop = resolve(boundary)
  for (;;) {
    const entry = await lstat(current).catch(() => null)
    if (!entry || entry.isSymbolicLink()) {
      return true
    }
    const parent = dirname(current)
    if (current === stop) {
      return false
    }
    if (parent === current) {
      return true
    }
    current = parent
  }
}

export async function classifyHomeSkillTopology(
  root: SkillScanRoot,
  unresolvedPath: string,
  canonicalRootPath: string
): Promise<ClassifiedSkillTopology> {
  let logicalStat: Awaited<ReturnType<typeof lstat>>
  try {
    logicalStat = await lstat(unresolvedPath)
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return {
        topology: 'broken-link',
        resolvedPath: null,
        identity: null,
        errorCategory: 'missing'
      }
    }
    throw error
  }
  const linked = logicalStat.isSymbolicLink()
  let resolvedPath: string
  let resolvedStat: Awaited<ReturnType<typeof stat>>
  try {
    resolvedPath = await realpath(unresolvedPath)
    resolvedStat = await stat(resolvedPath)
  } catch {
    return {
      topology: 'broken-link',
      resolvedPath: null,
      identity: null,
      errorCategory: 'dangling-link'
    }
  }
  if (!resolvedStat.isDirectory()) {
    return {
      topology: 'broken-link',
      resolvedPath,
      identity: null,
      errorCategory: 'not-directory'
    }
  }

  const identity = skillPhysicalIdentity(resolvedPath, resolvedStat)
  const canonicalRoot = await realpath(canonicalRootPath).catch(() => resolve(canonicalRootPath))
  const homeBoundary = dirname(dirname(canonicalRootPath))
  const rootOrProviderParentLinked = await hasSymlinkedAncestor(root.path, homeBoundary)
  const isCanonicalTarget =
    normalizedSkillIdentityPath(dirname(resolvedPath)) ===
    normalizedSkillIdentityPath(canonicalRoot)
  let topology: SkillInstallationTopology
  if (linked) {
    topology = isCanonicalTarget ? 'provider-alias' : 'external-link'
  } else if (rootOrProviderParentLinked) {
    topology = 'external-link'
  } else {
    topology = root.id === 'home-agents' ? 'canonical-copy' : 'independent-copy'
  }
  if (topology !== 'external-link' && !(await writableDestination(resolvedPath))) {
    topology = 'read-only'
  }
  return { topology, resolvedPath, identity, errorCategory: null }
}

export async function classifyUnsupportedSkillTopology(
  directoryPath: string,
  sourceKind: 'repo' | 'plugin'
): Promise<ClassifiedSkillTopology> {
  try {
    const resolvedPath = await realpath(directoryPath)
    const resolvedStat = await stat(resolvedPath)
    if (!resolvedStat.isDirectory()) {
      throw new Error('not-directory')
    }
    return {
      topology: sourceKind === 'repo' ? 'repo-scope' : 'plugin-cache',
      resolvedPath,
      identity: skillPhysicalIdentity(resolvedPath, resolvedStat),
      errorCategory: null
    }
  } catch (error) {
    return {
      topology: sourceKind === 'repo' ? 'repo-scope' : 'plugin-cache',
      resolvedPath: null,
      identity: null,
      errorCategory: error instanceof Error ? error.message : 'read-failed'
    }
  }
}
