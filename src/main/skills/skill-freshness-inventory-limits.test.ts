import { describe, expect, it } from 'vitest'
import {
  boundRepositorySkillRoots,
  MAXIMUM_REPOSITORY_SKILL_ROOTS
} from './skill-freshness-inventory'
import type { SkillScanRoot } from './skill-discovery-sources'

describe('skill freshness inventory limits', () => {
  it('caps repository roots before creating candidate probes', () => {
    const roots = Array.from(
      { length: MAXIMUM_REPOSITORY_SKILL_ROOTS + 3 },
      (_, index): SkillScanRoot => ({
        id: `repo-${index}`,
        label: `Repo ${index}`,
        path: `/repo-${index}/.agents/skills`,
        sourceKind: 'repo',
        providers: ['agent-skills']
      })
    )

    const bounded = boundRepositorySkillRoots(roots)

    expect(bounded.scanned).toHaveLength(MAXIMUM_REPOSITORY_SKILL_ROOTS)
    expect(bounded.omitted).toHaveLength(3)
  })
})
