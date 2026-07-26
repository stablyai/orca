import { describe, expect, it } from 'vitest'
import type { DiscoveredSkill } from '../../shared/skills'
import type { SkillScanRoot } from './skill-discovery-sources'
import {
  MAX_SKILL_DISCOVERY_CANDIDATES,
  MAX_SKILL_DISCOVERY_RESULT_BYTES,
  MAX_SKILL_DISCOVERY_ROOTS,
  SkillDiscoveryBudget,
  WSL_SKILL_DISCOVERY_MAX_OUTPUT_BYTES,
  assertSkillDiscoveryOutputWithinLimit
} from './skill-discovery-limits'

function root(index: number): SkillScanRoot {
  return {
    id: `root-${index}`,
    label: `Root ${index}`,
    path: `/skills/${index}`,
    sourceKind: 'home',
    providers: ['agent-skills'],
    owner: null
  }
}

function skill(description: string): DiscoveredSkill {
  return {
    id: 'skill-id',
    name: 'Skill',
    description,
    providers: ['agent-skills'],
    sourceKind: 'home',
    sourceLabel: 'Agent skills home',
    rootPath: '/skills',
    directoryPath: '/skills/example',
    skillFilePath: '/skills/example/SKILL.md',
    installed: true,
    fileCount: 1,
    updatedAt: null
  }
}

describe('installed-skill discovery limits', () => {
  it('rejects root and candidate counts beyond their fixed budgets', () => {
    expect(
      () =>
        new SkillDiscoveryBudget(
          Array.from({ length: MAX_SKILL_DISCOVERY_ROOTS + 1 }, (_, index) => root(index))
        )
    ).toThrow(/too many roots/)

    const budget = new SkillDiscoveryBudget([root(0)])
    for (let index = 0; index < MAX_SKILL_DISCOVERY_CANDIDATES; index += 1) {
      budget.admitCandidate()
    }
    expect(() => budget.admitCandidate()).toThrow(/too many skills/)
  })

  it('rejects retained result text and WSL output beyond their byte budgets', () => {
    const budget = new SkillDiscoveryBudget([root(0)])
    expect(() =>
      budget.retainSkill(skill('x'.repeat(Math.floor(MAX_SKILL_DISCOVERY_RESULT_BYTES / 2))))
    ).toThrow(/result is too large/)

    expect(() =>
      assertSkillDiscoveryOutputWithinLimit('x'.repeat(WSL_SKILL_DISCOVERY_MAX_OUTPUT_BYTES + 1))
    ).toThrow(/output is too large/)
  })
})
