import { dirname } from 'node:path'
import type { CodexEffectiveSkill, DiscoveredSkill, SkillSourceKind } from '../../shared/skills'
import { stablePathId } from './skill-discovery-sources'

function sourceKindForScope(scope: CodexEffectiveSkill['scope']): SkillSourceKind {
  if (scope === 'repo') {
    return 'repo'
  }
  if (scope === 'system' || scope === 'admin') {
    return 'bundled'
  }
  return 'home'
}

export function adaptCodexEffectiveSkills(
  skills: readonly CodexEffectiveSkill[]
): DiscoveredSkill[] {
  return skills
    .filter((skill) => skill.enabled)
    .map((skill) => {
      const directoryPath = dirname(skill.path)
      const sourceKind = sourceKindForScope(skill.scope)
      return {
        id: stablePathId(`${skill.name}\0${skill.path}`),
        name: skill.name,
        description: skill.description || null,
        providers: ['codex'],
        sourceKind,
        sourceLabel: skill.scope === 'repo' ? 'Repo' : 'Codex',
        rootPath: directoryPath,
        directoryPath,
        skillFilePath: skill.path,
        installed: true,
        fileCount: 1,
        updatedAt: null
      } satisfies DiscoveredSkill
    })
}
