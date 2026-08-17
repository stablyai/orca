import {
  AGENT_SKILL_SELECTOR_AMBIGUOUS_CODE,
  AGENT_SKILL_SELECTOR_NOT_FOUND_CODE,
  AgentSkillSharingError
} from '../../shared/agent-skill-sharing-contract'
import type { DiscoveredSkill } from '../../shared/skills'

export function selectDiscoveredSkills(
  skills: readonly DiscoveredSkill[],
  selectors: readonly string[]
): DiscoveredSkill[] {
  const selected = new Map<string, DiscoveredSkill>()
  for (const selector of selectors) {
    const exactId = skills.find((skill) => skill.id === selector)
    if (exactId) {
      selected.set(exactId.id, exactId)
      continue
    }
    const named = skills.filter((skill) => skill.name === selector)
    if (named.length === 0) {
      throw new AgentSkillSharingError(
        AGENT_SKILL_SELECTOR_NOT_FOUND_CODE,
        `Installed skill "${selector}" was not found. Run \`orca skills installed\` to list valid selectors.`,
        { selector }
      )
    }
    if (named.length > 1) {
      throw new AgentSkillSharingError(
        AGENT_SKILL_SELECTOR_AMBIGUOUS_CODE,
        `More than one installed skill is named "${selector}". Use its discovery ID from \`orca skills installed\`.`,
        { selector, matchingIds: named.map((skill) => skill.id) }
      )
    }
    selected.set(named[0].id, named[0])
  }
  const values = [...selected.values()]
  const byName = new Map<string, DiscoveredSkill[]>()
  for (const skill of values) {
    byName.set(skill.name, [...(byName.get(skill.name) ?? []), skill])
  }
  const collision = [...byName.entries()].find(([, named]) => named.length > 1)
  if (collision) {
    throw new AgentSkillSharingError(
      AGENT_SKILL_SELECTOR_AMBIGUOUS_CODE,
      `The selected skills include more than one installed skill named "${collision[0]}". Publish them in separate bundles.`,
      { selector: collision[0], matchingIds: collision[1].map((skill) => skill.id) }
    )
  }
  return values
}
