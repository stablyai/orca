import type { DiscoveredSkill } from '../../shared/skills'
import type { SkillScanRoot } from './skill-discovery-sources'

export const MAX_SKILL_DISCOVERY_ROOTS = 512
export const MAX_SKILL_DISCOVERY_CANDIDATES = 1_024
export const MAX_SKILL_DISCOVERY_TRAVERSED_DIRECTORIES = 20_000
export const MAX_SKILL_DISCOVERY_TRAVERSED_ENTRIES = 100_000
export const MAX_SKILL_DISCOVERY_RESULT_BYTES = 4 * 1024 * 1024
export const MAX_CONCURRENT_SKILL_DISCOVERY_ROOTS = 4
export const MAX_CONCURRENT_SKILL_DISCOVERY_CANDIDATES = 4
export const MAX_SKILL_PACKAGE_DIRECTORIES = 512
export const MAX_SKILL_PACKAGE_ENTRIES = 10_000
export const WSL_SKILL_DISCOVERY_MAX_OUTPUT_BYTES = 8 * 1024 * 1024

export class SkillDiscoveryLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SkillDiscoveryLimitError'
  }
}

export function assertSkillDiscoveryRootsWithinLimit(roots: readonly SkillScanRoot[]): void {
  if (roots.length > MAX_SKILL_DISCOVERY_ROOTS) {
    throw new SkillDiscoveryLimitError(
      `Installed-skill discovery has too many roots (${roots.length}; max ${MAX_SKILL_DISCOVERY_ROOTS}).`
    )
  }
}

function stringBytes(value: string | null | undefined): number {
  return (value?.length ?? 0) * 2
}

export function estimateDiscoveredSkillBytes(skill: DiscoveredSkill): number {
  return (
    256 +
    stringBytes(skill.id) +
    stringBytes(skill.name) +
    stringBytes(skill.description) +
    stringBytes(skill.sourceLabel) +
    stringBytes(skill.rootPath) +
    stringBytes(skill.directoryPath) +
    stringBytes(skill.skillFilePath) +
    skill.providers.reduce((bytes, provider) => bytes + stringBytes(provider), 0) +
    (skill.rootPaths ?? []).reduce((bytes, rootPath) => bytes + stringBytes(rootPath), 0)
  )
}

function estimateSkillSourceBytes(source: SkillScanRoot): number {
  return (
    192 +
    stringBytes(source.id) +
    stringBytes(source.label) +
    stringBytes(source.path) +
    source.providers.reduce((bytes, provider) => bytes + stringBytes(provider), 0)
  )
}

export class SkillDiscoveryBudget {
  private candidates = 0
  private directories = 0
  private entries = 0
  private retainedBytes = 0

  constructor(roots: readonly SkillScanRoot[]) {
    assertSkillDiscoveryRootsWithinLimit(roots)
    for (const root of roots) {
      this.retainBytes(estimateSkillSourceBytes(root))
    }
  }

  visitDirectory(): void {
    this.directories += 1
    if (this.directories > MAX_SKILL_DISCOVERY_TRAVERSED_DIRECTORIES) {
      throw new SkillDiscoveryLimitError(
        `Installed-skill discovery visited too many directories (max ${MAX_SKILL_DISCOVERY_TRAVERSED_DIRECTORIES}).`
      )
    }
  }

  visitEntry(): void {
    this.entries += 1
    if (this.entries > MAX_SKILL_DISCOVERY_TRAVERSED_ENTRIES) {
      throw new SkillDiscoveryLimitError(
        `Installed-skill discovery visited too many entries (max ${MAX_SKILL_DISCOVERY_TRAVERSED_ENTRIES}).`
      )
    }
  }

  admitCandidate(): void {
    this.candidates += 1
    if (this.candidates > MAX_SKILL_DISCOVERY_CANDIDATES) {
      throw new SkillDiscoveryLimitError(
        `Installed-skill discovery found too many skills (max ${MAX_SKILL_DISCOVERY_CANDIDATES}).`
      )
    }
  }

  retainSkill(skill: DiscoveredSkill): void {
    this.retainBytes(estimateDiscoveredSkillBytes(skill))
  }

  private retainBytes(bytes: number): void {
    this.retainedBytes += bytes
    if (this.retainedBytes > MAX_SKILL_DISCOVERY_RESULT_BYTES) {
      throw new SkillDiscoveryLimitError(
        `Installed-skill discovery result is too large (max ${MAX_SKILL_DISCOVERY_RESULT_BYTES} bytes).`
      )
    }
  }
}

export function assertSkillDiscoveryOutputWithinLimit(output: string): void {
  if (Buffer.byteLength(output, 'utf8') > WSL_SKILL_DISCOVERY_MAX_OUTPUT_BYTES) {
    throw new SkillDiscoveryLimitError(
      `WSL installed-skill discovery output is too large (max ${WSL_SKILL_DISCOVERY_MAX_OUTPUT_BYTES} bytes).`
    )
  }
}
