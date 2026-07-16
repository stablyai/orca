import type { Stats } from 'node:fs'
import { join } from 'node:path'
import type {
  SkillCurrentBundleEntry,
  SkillFreshnessInstallation,
  SkillFreshnessStatus,
  SkillKnownSnapshot
} from '../../shared/skill-freshness'
import type { SkillScanRoot } from './skill-discovery-sources'
import type { SkillBundleArtifacts } from './skill-bundle-artifacts'
import { matchingKnownSnapshot, observeSkillPackage } from './skill-package-identity'
import {
  classifyHomeSkillTopology,
  classifyUnsupportedSkillTopology,
  skillPlacementId,
  skillTopologyPriority,
  type ClassifiedSkillTopology
} from './skill-installation-topology'

export type CandidateLstat = (path: string) => Promise<Stats>

function freshnessStatus(
  snapshot: SkillKnownSnapshot | null,
  current: SkillCurrentBundleEntry
): SkillFreshnessStatus {
  if (!snapshot) {
    return 'unrecognized'
  }
  if (snapshot.releaseRevision > current.releaseRevision) {
    return 'newer-known'
  }
  return snapshot.packageDigest === current.packageDigest ? 'current' : 'outdated'
}

function errorCategory(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

function isInaccessibleError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error.code === 'EACCES' || error.code === 'EPERM')
  )
}

function knownSnapshots(
  artifacts: SkillBundleArtifacts,
  current: SkillCurrentBundleEntry
): SkillKnownSnapshot[] {
  const snapshots = artifacts.knownSnapshots[current.name] ?? []
  return snapshots.some((snapshot) => snapshot.packageDigest === current.packageDigest)
    ? snapshots
    : [...snapshots, current]
}

export async function observeSkillFreshnessInstallation(args: {
  current: SkillCurrentBundleEntry
  artifacts: SkillBundleArtifacts
  rootId: string
  providers: SkillFreshnessInstallation['providers']
  sourceKind: SkillFreshnessInstallation['sourceKind']
  sourceLabel: string
  unresolvedPath: string
  topology: ClassifiedSkillTopology
}): Promise<SkillFreshnessInstallation> {
  const base = {
    id: skillPlacementId(args.unresolvedPath, args.current.name),
    name: args.current.name,
    rootId: args.rootId,
    providers: args.providers,
    sourceKind: args.sourceKind,
    sourceLabel: args.sourceLabel,
    unresolvedPath: args.unresolvedPath,
    resolvedPath: args.topology.resolvedPath,
    physicalIdentity: args.topology.identity,
    topology: args.topology.topology,
    currentReleaseRevision: args.current.releaseRevision,
    currentPackageDigest: args.current.packageDigest,
    currentAppVersion: args.current.appVersion,
    errorCategory: args.topology.errorCategory
  }
  if (!args.topology.resolvedPath || !args.topology.identity) {
    return {
      ...base,
      status: 'inaccessible',
      installedReleaseRevision: null,
      installedAppVersion: null,
      observedPackageDigest: null
    }
  }

  try {
    const observed = await observeSkillPackage(args.topology.resolvedPath)
    const matchedSnapshot = matchingKnownSnapshot(
      observed,
      knownSnapshots(args.artifacts, args.current)
    )
    // Why: a later release can reintroduce identical bytes. Exact current
    // identity is still current, and cannot honestly be attributed to the later tag.
    const snapshot =
      observed.observedDigest === args.current.packageDigest ? args.current : matchedSnapshot
    return {
      ...base,
      status: freshnessStatus(snapshot, args.current),
      installedReleaseRevision: snapshot?.releaseRevision ?? null,
      installedAppVersion: snapshot
        ? (args.artifacts.releasedAppVersions[args.current.name]?.[snapshot.releaseRevision] ??
          null)
        : null,
      observedPackageDigest: observed.observedDigest
    }
  } catch (error) {
    return {
      ...base,
      status: isInaccessibleError(error) ? 'inaccessible' : 'unrecognized',
      installedReleaseRevision: null,
      installedAppVersion: null,
      observedPackageDigest: null,
      errorCategory: errorCategory(error, 'skill-package-read-failed')
    }
  }
}

export async function classifyHomeSkillCandidate(args: {
  root: SkillScanRoot
  current: SkillCurrentBundleEntry
  artifacts: SkillBundleArtifacts
  canonicalRootPath: string
  candidateLstat: CandidateLstat
}): Promise<SkillFreshnessInstallation | null> {
  const unresolvedPath = join(args.root.path, args.current.name)
  try {
    await args.candidateLstat(unresolvedPath)
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return null
    }
    return observeSkillFreshnessInstallation({
      current: args.current,
      artifacts: args.artifacts,
      rootId: args.root.id,
      providers: args.root.providers,
      sourceKind: args.root.sourceKind,
      sourceLabel: args.root.label,
      unresolvedPath,
      topology: {
        topology: 'broken-link',
        resolvedPath: null,
        identity: null,
        errorCategory: errorCategory(error, 'skill-candidate-inaccessible')
      }
    })
  }

  let topology: ClassifiedSkillTopology
  try {
    topology = await classifyHomeSkillTopology(args.root, unresolvedPath, args.canonicalRootPath)
  } catch (error) {
    topology = {
      topology: 'broken-link',
      resolvedPath: null,
      identity: null,
      errorCategory: errorCategory(error, 'skill-candidate-topology-failed')
    }
  }
  return observeSkillFreshnessInstallation({
    current: args.current,
    artifacts: args.artifacts,
    rootId: args.root.id,
    providers: args.root.providers,
    sourceKind: args.root.sourceKind,
    sourceLabel: args.root.label,
    unresolvedPath,
    topology
  })
}

export async function classifyUnsupportedSkillCandidate(args: {
  root: SkillScanRoot
  current: SkillCurrentBundleEntry
  artifacts: SkillBundleArtifacts
  unresolvedPath: string
  candidateLstat: CandidateLstat
}): Promise<SkillFreshnessInstallation | null> {
  try {
    await args.candidateLstat(args.unresolvedPath)
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return null
    }
    return observeSkillFreshnessInstallation({
      current: args.current,
      artifacts: args.artifacts,
      rootId: args.root.id,
      providers: args.root.providers,
      sourceKind: args.root.sourceKind,
      sourceLabel: args.root.label,
      unresolvedPath: args.unresolvedPath,
      topology: {
        topology: args.root.sourceKind === 'repo' ? 'repo-scope' : 'plugin-cache',
        resolvedPath: null,
        identity: null,
        errorCategory: errorCategory(error, 'unsupported-candidate-inaccessible')
      }
    })
  }
  return observeSkillFreshnessInstallation({
    current: args.current,
    artifacts: args.artifacts,
    rootId: args.root.id,
    providers: args.root.providers,
    sourceKind: args.root.sourceKind,
    sourceLabel: args.root.label,
    unresolvedPath: args.unresolvedPath,
    topology: await classifyUnsupportedSkillTopology(
      args.unresolvedPath,
      args.root.sourceKind === 'repo' ? 'repo' : 'plugin'
    )
  })
}

function topologyDedupeBucket(installation: SkillFreshnessInstallation): string {
  return installation.topology === 'canonical-copy' || installation.topology === 'provider-alias'
    ? 'managed-global'
    : installation.topology
}

export function dedupeSkillFreshnessPlacements(
  installations: readonly SkillFreshnessInstallation[]
): SkillFreshnessInstallation[] {
  const deduped = new Map<string, SkillFreshnessInstallation>()
  for (const installation of installations) {
    const key = installation.physicalIdentity
      ? `${installation.name}\0${installation.physicalIdentity}\0${topologyDedupeBucket(installation)}`
      : `logical\0${installation.id}`
    const existing = deduped.get(key)
    if (!existing) {
      deduped.set(key, installation)
      continue
    }
    const providers = [...new Set([...existing.providers, ...installation.providers])]
    if (skillTopologyPriority(installation.topology) > skillTopologyPriority(existing.topology)) {
      deduped.set(key, { ...installation, providers })
    } else {
      existing.providers = providers
    }
  }
  return [...deduped.values()]
}
