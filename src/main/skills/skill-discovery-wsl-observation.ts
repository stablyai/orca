import { posix as pathPosix } from 'node:path'
import { summarizeSkillMarkdown } from '../../shared/skill-metadata'
import type {
  DiscoveredSkill,
  SkillDiscoveryResult,
  SkillDiscoverySource,
  SkillSourceKind
} from '../../shared/skills'
import {
  sortDiscoveredSkills,
  sortSkillDiscoverySources,
  sourceKindForSkill,
  sourceLabelForSkill,
  stablePathId,
  type SkillScanRoot
} from './skill-discovery-sources'
import { rootMayContainSourceKind } from './skill-discovery-source-filter'

export type WslSkillDiscoveryObservation = {
  rows: { canonicalSkillFilePath: string; skill: DiscoveredSkill }[]
  sources: SkillDiscoverySource[]
  scannedAt: number
}

function readProtocolField(fields: string[], index: number): string {
  const value = fields[index]
  if (value === undefined) {
    throw new Error('WSL skill discovery returned an incomplete response.')
  }
  return value
}

export function readWslSkillDiscoveryObservation(
  output: string,
  roots: readonly SkillScanRoot[],
  scannedAt = Date.now()
): WslSkillDiscoveryObservation {
  const fields = output.split('\0')
  const rootExists = new Map<number, boolean>()
  const rows: WslSkillDiscoveryObservation['rows'] = []
  let index = 0
  while (index < fields.length && fields[index]) {
    const recordKind = fields[index++]
    const rootIndex = Number.parseInt(readProtocolField(fields, index++), 10)
    const root = roots[rootIndex]
    if (!root) {
      throw new Error('WSL skill discovery returned an unknown source.')
    }
    if (recordKind === 'R') {
      rootExists.set(rootIndex, readProtocolField(fields, index++) === '1')
      continue
    }
    if (recordKind !== 'S') {
      throw new Error('WSL skill discovery returned an invalid response.')
    }

    const skillFilePath = readProtocolField(fields, index++)
    const canonicalSkillFilePath = readProtocolField(fields, index++)
    const updatedAtSeconds = Number.parseInt(readProtocolField(fields, index++), 10)
    const markdown = Buffer.from(readProtocolField(fields, index++), 'base64').toString('utf8')
    const directoryPath = pathPosix.dirname(skillFilePath)
    const summary = summarizeSkillMarkdown(markdown)
    const sourceKind = sourceKindForSkill(root, skillFilePath, pathPosix)
    const directoryName = pathPosix.basename(directoryPath)
    rows.push({
      canonicalSkillFilePath,
      skill: {
        id: stablePathId(canonicalSkillFilePath),
        name: summary.name ?? directoryName,
        description: summary.description,
        // Copy: `root.providers` is shared across every skill/source from this
        // root, so a later in-place merge must not mutate the aliased array.
        providers: [...root.providers],
        sourceKind,
        sourceLabel: sourceLabelForSkill(root, sourceKind),
        rootPath: root.path,
        rootPaths: [root.path],
        directoryPath,
        skillFilePath,
        installed: true,
        updatedAt: Number.isFinite(updatedAtSeconds) ? updatedAtSeconds * 1000 : null
      }
    })
  }

  const sources: SkillDiscoverySource[] = roots.map((root, rootIndex) => {
    const exists = rootExists.get(rootIndex) ?? false
    return {
      ...root,
      providers: [...root.providers],
      exists,
      skippedReason: exists ? undefined : 'missing'
    }
  })
  return {
    rows,
    sources: sortSkillDiscoverySources(sources),
    scannedAt
  }
}

export function projectWslSkillDiscovery(
  observation: WslSkillDiscoveryObservation,
  sourceKinds?: readonly SkillSourceKind[],
  names?: readonly string[]
): SkillDiscoveryResult {
  const normalizedNames = names
    ?.values()
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean)
    .toArray()
  const expectedNames = normalizedNames?.length ? new Set(normalizedNames) : undefined
  const skillsByCanonicalPath = new Map<string, DiscoveredSkill>()
  for (const { canonicalSkillFilePath, skill } of observation.rows) {
    if (sourceKinds?.length && !sourceKinds.includes(skill.sourceKind)) {
      continue
    }
    const directoryName = pathPosix.basename(skill.directoryPath)
    if (
      expectedNames &&
      !expectedNames.has(skill.name.trim().toLowerCase()) &&
      !expectedNames.has(directoryName.trim().toLowerCase())
    ) {
      continue
    }
    // Filter aliases before deduplication; each name/source may select a different row.
    const existing = skillsByCanonicalPath.get(canonicalSkillFilePath)
    if (existing) {
      const existingRoots = (existing.rootPaths ??= [existing.rootPath])
      for (const rootPath of skill.rootPaths ?? [skill.rootPath]) {
        if (!existingRoots.includes(rootPath)) {
          existingRoots.push(rootPath)
        }
      }
      for (const provider of skill.providers) {
        if (!existing.providers.includes(provider)) {
          existing.providers.push(provider)
        }
      }
      continue
    }
    skillsByCanonicalPath.set(canonicalSkillFilePath, {
      ...skill,
      providers: [...skill.providers],
      rootPaths: [...(skill.rootPaths ?? [skill.rootPath])]
    })
  }
  return {
    skills: sortDiscoveredSkills([...skillsByCanonicalPath.values()]),
    sources: observation.sources
      .filter((source) => rootMayContainSourceKind(source, sourceKinds))
      .map((source) => ({ ...source, providers: [...source.providers] })),
    scannedAt: observation.scannedAt
  }
}

export function parseWslSkillDiscoveryOutput(
  output: string,
  roots: readonly SkillScanRoot[],
  scannedAt = Date.now(),
  sourceKinds?: readonly SkillSourceKind[],
  names?: readonly string[]
): SkillDiscoveryResult {
  return projectWslSkillDiscovery(
    readWslSkillDiscoveryObservation(output, roots, scannedAt),
    sourceKinds,
    names
  )
}
