import { describe, expect, it } from 'vitest'
import type { DiscoveredSkill } from '../../../shared/skills'
import {
  AGENT_SKILL_SELECTOR_AMBIGUOUS_CODE,
  AgentSkillSharingError
} from '../../../shared/agent-skill-sharing-contract'
import { selectDiscoveredSkills } from './agent-skill-selection'

function skill(id: string, name: string): DiscoveredSkill {
  return {
    id,
    name,
    description: null,
    providers: ['agent-skills'],
    sourceKind: 'home',
    sourceLabel: 'Shared',
    rootPath: '/skills',
    directoryPath: `/skills/${id}`,
    skillFilePath: `/skills/${id}/SKILL.md`,
    installed: true,
    updatedAt: null
  }
}

describe('agent skill selection', () => {
  it('accepts exact IDs and unambiguous names while deduplicating repeats', () => {
    expect(
      selectDiscoveredSkills(
        [skill('id-alpha', 'alpha'), skill('id-beta', 'beta')],
        ['alpha', 'id-beta', 'alpha']
      ).map((entry) => entry.id)
    ).toEqual(['id-alpha', 'id-beta'])
  })
})

// CLI ambiguity output must retain every match in discovery order.
it('reports every ambiguous match in discovery order', () => {
  let thrown: unknown
  try {
    selectDiscoveredSkills(
      [skill('one', 'same'), skill('unrelated', 'other'), skill('two', 'same')],
      ['same']
    )
  } catch (error) {
    thrown = error
  }
  expect(thrown).toBeInstanceOf(AgentSkillSharingError)
  const error = thrown as AgentSkillSharingError
  expect(error.code).toBe(AGENT_SKILL_SELECTOR_AMBIGUOUS_CODE)
  expect(error.data).toEqual({ selector: 'same', matchingIds: ['one', 'two'] })
})

it('retains first duplicate ID authority and exact ID precedence over names', () => {
  const first = skill('id', 'first')
  expect(
    selectDiscoveredSkills([first, skill('id', 'second'), skill('other', 'id')], ['id'])
  ).toEqual([first])
})
