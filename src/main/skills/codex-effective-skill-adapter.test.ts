import { describe, expect, it } from 'vitest'
import { adaptCodexEffectiveSkills } from './codex-effective-skill-adapter'
import type { CodexEffectiveSkill } from '../../shared/skills'

function skill(overrides: Partial<CodexEffectiveSkill> = {}): CodexEffectiveSkill {
  return {
    name: 'plugin:search',
    description: 'Search',
    path: '/home/.codex/plugins/cache/plugin/2.0.0/skills/search/SKILL.md',
    scope: 'user',
    enabled: true,
    ...overrides
  }
}

describe('adaptCodexEffectiveSkills', () => {
  it('excludes disabled and uninstalled cache entries because only effective entries are adapted', () => {
    const result = adaptCodexEffectiveSkills([
      skill({ enabled: false }),
      skill({ name: 'plugin:active' })
    ])
    expect(result.map((entry) => entry.name)).toEqual(['plugin:active'])
  })

  it('preserves the app-server namespace and active version path', () => {
    const result = adaptCodexEffectiveSkills([
      skill(),
      skill({
        name: 'other:search',
        path: '/home/.codex/plugins/cache/other/1.0.0/skills/search/SKILL.md'
      })
    ])
    expect(result.map(({ name, skillFilePath }) => [name, skillFilePath])).toEqual([
      ['plugin:search', '/home/.codex/plugins/cache/plugin/2.0.0/skills/search/SKILL.md'],
      ['other:search', '/home/.codex/plugins/cache/other/1.0.0/skills/search/SKILL.md']
    ])
    expect(new Set(result.map((entry) => entry.id)).size).toBe(2)
  })

  it('keeps shared user and repo roots classified without scanning either root', () => {
    const result = adaptCodexEffectiveSkills([
      skill({ name: 'shared', path: '/home/.agents/skills/shared/SKILL.md' }),
      skill({ name: 'repo', path: '/repo/.agents/skills/repo/SKILL.md', scope: 'repo' })
    ])
    expect(result.map(({ name, sourceKind }) => [name, sourceKind])).toEqual([
      ['shared', 'home'],
      ['repo', 'repo']
    ])
  })
})
