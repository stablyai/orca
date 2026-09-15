import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DiscoveredSkill, SkillDiscoverySource } from '../../shared/skills'
import { sortDiscoveredSkills, sortSkillDiscoverySources } from './skill-discovery-sources'

// Scripts and case/accent/numeric shapes whose collation differs between locales
// and ICU builds, so a reused collator that drifted from `localeCompare` shows up.
const COLLATION_CORPUS = [
  '',
  ' ',
  'a',
  'A',
  'éclair',
  'Eclair',
  'ÉCLAIR',
  'Ångström',
  'Angstrom',
  'İstanbul',
  'Istanbul',
  'ıstanbul',
  'straße',
  'strasse',
  'STRASSE',
  'ẞ',
  '中文',
  '日本語',
  'にほんご',
  '한국어',
  'item2',
  'item10',
  'item01',
  'ITEM2',
  '10',
  '2',
  'ñ',
  'n',
  'œ',
  'oe',
  'æ',
  'привет',
  'ПРИВЕТ',
  'skill-a',
  'skill_a',
  'skill a',
  'co-op',
  'coop',
  'zebra',
  'zebra'
]

function skill(index: number): DiscoveredSkill {
  return {
    id: String(index),
    name: ['éclair', 'Eclair', 'item2', 'item10', 'Ångström', 'zebra', 'İstanbul'][index % 7],
    description: null,
    providers: ['codex'],
    sourceKind: 'home',
    sourceLabel: ['Home', 'hôme', 'Repo', 'repo'][index % 4],
    rootPath: '/skills',
    directoryPath: '/skills/example',
    skillFilePath: `/skills/${index % 13}/SKILL.md`,
    installed: true,
    updatedAt: null
  }
}

// Preserve the original comparator as the ordering and operation-count oracle.
function compareOriginal(a: DiscoveredSkill, b: DiscoveredSkill): number {
  return (
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) ||
    a.sourceLabel.localeCompare(b.sourceLabel, undefined, { sensitivity: 'base' }) ||
    a.skillFilePath.localeCompare(b.skillFilePath)
  )
}

function discoverySource(index: number): SkillDiscoverySource {
  return {
    id: String(index),
    label: COLLATION_CORPUS[index % COLLATION_CORPUS.length],
    path: `/roots/${index}`,
    sourceKind: 'home',
    providers: ['codex'],
    owner: null,
    exists: true
  }
}

afterEach(() => vi.restoreAllMocks())

describe('discovered skill ordering', () => {
  it('preserves name, source, path and stable ties with one collator per sort', () => {
    const skills = Array.from({ length: 2_000 }, (_, index) => skill(index))
    const localeCompare = vi.spyOn(String.prototype, 'localeCompare')
    const expected = [...skills].sort(compareOriginal)
    const optionedCalls = (): number =>
      localeCompare.mock.calls.filter((args) => args[2] !== undefined).length
    expect(optionedCalls()).toBeGreaterThan(10_000)
    localeCompare.mockClear()
    const NativeCollator = Intl.Collator
    const construct = vi.spyOn(Intl, 'Collator').mockImplementation(function (locales, options) {
      return new NativeCollator(locales, options)
    })

    expect(sortDiscoveredSkills(skills)).toBe(skills)
    expect(skills.map(({ id }) => id)).toEqual(expected.map(({ id }) => id))
    expect(optionedCalls()).toBe(0)
    expect(construct).toHaveBeenCalledExactlyOnceWith(undefined, { sensitivity: 'base' })
    sortDiscoveredSkills([...skills])
    expect(construct).toHaveBeenCalledTimes(2)
  })

  it('matches the per-call comparator across scripts, case, accents and numerals', () => {
    const skills = COLLATION_CORPUS.flatMap((name, index) =>
      COLLATION_CORPUS.map((sourceLabel, inner) => ({
        ...skill(index),
        id: `${index}-${inner}`,
        name,
        sourceLabel
      }))
    )
    expect(skills.length).toBe(COLLATION_CORPUS.length ** 2)
    const expected = [...skills].sort(compareOriginal)
    expect(sortDiscoveredSkills([...skills]).map(({ id }) => id)).toEqual(
      expected.map(({ id }) => id)
    )
  })

  it('sorts discovery sources like the per-call label comparator', () => {
    const sources = Array.from({ length: 400 }, (_, index) => discoverySource(index))
    const expected = [...sources].sort((a, b) =>
      // oxlint-disable-next-line sort-comparator-performance/no-repeated-collator -- Parity oracle.
      a.label.localeCompare(b.label, undefined, { sensitivity: 'base' })
    )
    const NativeCollator = Intl.Collator
    const construct = vi.spyOn(Intl, 'Collator').mockImplementation(function (locales, options) {
      return new NativeCollator(locales, options)
    })
    expect(sortSkillDiscoverySources(sources).map(({ id }) => id)).toEqual(
      expected.map(({ id }) => id)
    )
    expect(construct).toHaveBeenCalledExactlyOnceWith(undefined, { sensitivity: 'base' })
  })

  it('does no comparison setup for empty or singleton discovery results', () => {
    const construct = vi.spyOn(Intl, 'Collator')
    for (const skills of [[], [skill(0)]]) {
      expect(sortDiscoveredSkills(skills)).toBe(skills)
    }
    for (const sources of [[], [discoverySource(0)]]) {
      expect(sortSkillDiscoverySources(sources)).toBe(sources)
    }
    expect(construct).not.toHaveBeenCalled()
  })
})
