import { describe, expect, it } from 'vitest'
import type { DiscoveredSkill } from '../../shared/skills'
import {
  AGENT_SKILL_SELECTOR_AMBIGUOUS_CODE,
  AGENT_SKILL_SELECTOR_NOT_FOUND_CODE,
  AgentSkillSharingError
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

it('indexes a batch of selectors without rescanning discovery', () => {
  let reads = 0
  const skills = Array.from({ length: 1000 }, (_, index) => ({
    ...skill(`id-${index}`, `name-${index}`),
    get id() {
      reads++
      return `id-${index}`
    }
  }))
  const selected = selectDiscoveredSkills(
    skills,
    skills.map((_, index) => `id-${index}`)
  )
  expect(selected).toHaveLength(1000)
  expect(selected[999]).toBe(skills[999])
  expect(reads).toBeLessThan(10000)
})

it('indexes only the requested selectors, not every discovered skill', () => {
  let nameReads = 0
  const skills = Array.from({ length: 1000 }, (_, index) => ({
    ...skill(`id-${index}`, `name-${index}`),
    get name() {
      nameReads++
      return `name-${index}`
    }
  }))
  expect(selectDiscoveredSkills(skills, ['id-900'])).toEqual([skills[900]])
  // One membership probe per discovered skill, plus reads for the single match's
  // own bucket and the trailing collision check. Indexing every name would need
  // three reads apiece.
  expect(nameReads).toBeLessThanOrEqual(1_100)
})

// `matchingIds` is what the CLI prints so the user can disambiguate, so the
// index must report every match in discovery order, exactly like the old filter.
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
