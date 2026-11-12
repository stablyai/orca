import { basename, dirname, join } from 'node:path'
import type { DiscoveredSkill } from '../../../shared/skills'
import { BUNDLED_SKILL_SOURCES } from '../bundled-skill-install/bundled-skill-sources'
import {
  bundledSkillTextDigest,
  classifyBundledSkillPath
} from '../bundled-skill-install/bundled-skill-classification'
import { nativeBundledSkillFilesystem } from '../bundled-skill-install/bundled-skill-filesystem'

/** Former generic names identify Orca only when their bytes match a shipped version. */
export function bundledSkillDiscoveryName(
  name: string | null,
  markdown: string
): string | undefined {
  const source = BUNDLED_SKILL_SOURCES.find(
    (candidate) => name && candidate.aliases?.includes(name)
  )
  return source &&
    source.releasedDigests.includes(bundledSkillTextDigest(Buffer.from(markdown, 'utf8')))
    ? source.name
    : undefined
}

/** A copy-only host retains a shared fallback; user-added files keep it visible. */
export async function withoutBundledSkillCompatibilityCopies<T extends DiscoveredSkill>(
  skills: readonly T[]
): Promise<T[]> {
  const canonical = new Set(
    skills
      .filter((skill) => basename(skill.directoryPath) === skill.name)
      .map((skill) => skill.directoryPath)
  )
  const visible: T[] = []
  for (const skill of skills) {
    const source =
      skill.bundledName &&
      BUNDLED_SKILL_SOURCES.find((candidate) => candidate.name === skill.bundledName)
    if (source && canonical.has(join(dirname(skill.directoryPath), source.name))) {
      const classified = await classifyBundledSkillPath(
        nativeBundledSkillFilesystem,
        skill.directoryPath,
        source,
        bundledSkillTextDigest(Buffer.from(source.text))
      )
      if (classified.folderClass === 'released' || classified.folderClass === 'current') {
        continue
      }
    }
    visible.push(skill)
  }
  return visible
}
