import type { Stats } from 'node:fs'
import { join } from 'node:path'
import type {
  SkillCurrentBundleEntry,
  SkillFreshnessInstallation
} from '../../shared/skill-freshness'
import type { SkillScanRoot } from './skill-discovery-sources'
import { matchesBundledSkillFiles, observeSkillPackage } from './skill-package-identity'
import {
  classifyHomeSkillTopology,
  classifyUnsupportedSkillTopology,
  skillPlacementId,
  skillTopologyPriority,
  type ClassifiedSkillTopology
} from './skill-installation-topology'

export type CandidateLstat = (path: string) => Promise<Stats>

function errorCategory(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

export async function observeSkillFreshnessInstallation(args: {
  current: SkillCurrentBundleEntry
  lockSource: string | null
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
    currentPackageDigest: args.current.packageDigest,
    lockSource: args.lockSource,
    errorCategory: args.topology.errorCategory
  }
  if (!args.topology.resolvedPath || !args.topology.identity) {
    return { ...base, status: 'inaccessible' }
  }

  try {
    const observed = await observeSkillPackage(args.topology.resolvedPath)
    // Why: the only question is whether this is the version this build ships. Any
    // difference, older release, unreleased commit or local edit alike, is outdated.
    return {
      ...base,
      status: matchesBundledSkillFiles(observed, args.current.files) ? 'current' : 'outdated'
    }
  } catch (error) {
    // Why: a package Orca could not read is never offered for overwrite on a guess.
    return {
      ...base,
      status: 'inaccessible',
      errorCategory: errorCategory(error, 'skill-package-read-failed')
    }
  }
}

export async function classifyHomeSkillCandidate(args: {
  root: SkillScanRoot
  current: SkillCurrentBundleEntry
  lockSource: string | null
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
      lockSource: args.lockSource,
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
    lockSource: args.lockSource,
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
  lockSource: string | null
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
      lockSource: args.lockSource,
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
    lockSource: args.lockSource,
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
