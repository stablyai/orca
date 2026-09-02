import { describe, expect, it } from 'vitest'
import type { DiscoveredSkill } from '../../shared/skills'
import {
  AGENT_SKILL_SELECTOR_AMBIGUOUS_CODE,
  AGENT_SKILL_SELECTOR_NOT_FOUND_CODE
} from '../../shared/agent-skill-sharing-contract'
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

  it('fails missing selectors with installed-list recovery', () => {
    expect(() => selectDiscoveredSkills([], ['missing'])).toThrow(
      expect.objectContaining({ code: AGENT_SKILL_SELECTOR_NOT_FOUND_CODE })
    )
  })

  it('requires an ID when names are ambiguous', () => {
    expect(() =>
      selectDiscoveredSkills([skill('one', 'same'), skill('two', 'same')], ['same'])
    ).toThrow(expect.objectContaining({ code: AGENT_SKILL_SELECTOR_AMBIGUOUS_CODE }))
  })

  it('rejects two exact IDs whose bundle folder names would collide', () => {
    expect(() =>
      selectDiscoveredSkills([skill('one', 'same'), skill('two', 'same')], ['one', 'two'])
    ).toThrow(expect.objectContaining({ code: AGENT_SKILL_SELECTOR_AMBIGUOUS_CODE }))
  })
})
