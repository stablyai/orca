import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import type {
  DiscoveredSkill,
  DiscoveredSkillPlacement
} from '../../../shared/skills/discovery/skills'

const CLAUDE_DEFAULT_SKILL_NAMES = new Set(['docs', 'docx', 'pdf', 'pptx', 'xlsx'])

export async function mergeIdenticalClaudeDefaultCopies(
  skills: readonly DiscoveredSkill[]
): Promise<DiscoveredSkill[]> {
  const groups = new Map<
    string,
    { skill: DiscoveredSkill; placements: DiscoveredSkillPlacement[] }
  >()
  const output: DiscoveredSkill[] = []

  for (const skill of skills) {
    const directoryName = basename(skill.directoryPath).toLowerCase()
    if (
      skill.sourceKind !== 'home' ||
      !skill.providers.includes('claude') ||
      skill.name.trim().toLowerCase() !== directoryName ||
      !CLAUDE_DEFAULT_SKILL_NAMES.has(directoryName)
    ) {
      output.push(skill)
      continue
    }

    let content: Buffer
    try {
      content = await readFile(skill.skillFilePath)
    } catch {
      output.push(skill)
      continue
    }
    const key = `${directoryName}\0${createHash('sha256').update(content).digest('hex')}`
    const placement: DiscoveredSkillPlacement = {
      id: skill.id,
      rootPath: skill.rootPath,
      directoryPath: skill.directoryPath,
      skillFilePath: skill.skillFilePath,
      updatedAt: skill.updatedAt
    }
    const group = groups.get(key)
    if (group) {
      group.placements.push(placement)
    } else {
      groups.set(key, { skill, placements: [placement] })
      output.push(skill)
    }
  }

  for (const group of groups.values()) {
    if (group.placements.length > 1) {
      group.skill.placements = group.placements
      group.skill.rootPaths = [
        ...new Set([
          ...(group.skill.rootPaths ?? []),
          ...group.placements.map((placement) => placement.rootPath)
        ])
      ]
    }
  }
  return output
}
