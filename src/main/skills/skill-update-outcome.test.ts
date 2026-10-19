import { describe, expect, it } from 'vitest'
import type {
  SkillFreshnessInstallation,
  SkillFreshnessStatus,
  SkillInstallationTopology
} from '../../shared/skill-freshness'
import { skillUpdateFailedNames } from './skill-update-outcome'

function placement(
  name: string,
  status: SkillFreshnessStatus,
  topology: SkillInstallationTopology = 'canonical-copy'
): SkillFreshnessInstallation {
  return {
    id: `${name}-${topology}-${status}`,
    name,
    rootId: 'home-agents',
    providers: ['agent-skills'],
    sourceKind: 'home',
    sourceLabel: 'Agent skills home',
    unresolvedPath: `/home/.agents/skills/${name}`,
    resolvedPath: `/home/.agents/skills/${name}`,
    physicalIdentity: `physical-${name}`,
    topology,
    status,
    currentPackageDigest: 'current',
    lockSource: 'stablyai/orca',
    errorCategory: null
  }
}

describe('skillUpdateFailedNames', () => {
  it('treats a convergent copy that is now current as landed', () => {
    expect(skillUpdateFailedNames(['orca-cli'], [placement('orca-cli', 'current')])).toEqual([])
  })

  it('reports a copy the run left outdated', () => {
    expect(skillUpdateFailedNames(['orca-cli'], [placement('orca-cli', 'outdated')])).toEqual([
      'orca-cli'
    ])
  })

  it('reports an unreadable copy', () => {
    expect(skillUpdateFailedNames(['orca-cli'], [placement('orca-cli', 'inaccessible')])).toEqual([
      'orca-cli'
    ])
  })

  it('reports a skill the run removed outright', () => {
    expect(skillUpdateFailedNames(['orca-cli'], [])).toEqual(['orca-cli'])
  })

  it('ignores placements the update command never writes to', () => {
    expect(
      skillUpdateFailedNames(
        ['orca-cli'],
        [placement('orca-cli', 'current'), placement('orca-cli', 'outdated', 'plugin-cache')]
      )
    ).toEqual([])
  })

  it('fails the name when the run leaves a broken link behind', () => {
    expect(
      skillUpdateFailedNames(
        ['orca-cli'],
        [placement('orca-cli', 'current'), placement('orca-cli', 'inaccessible', 'broken-link')]
      )
    ).toEqual(['orca-cli'])
  })

  it('fails the name when any convergent alias was left behind', () => {
    expect(
      skillUpdateFailedNames(
        ['orca-cli'],
        [placement('orca-cli', 'current'), placement('orca-cli', 'outdated', 'provider-alias')]
      )
    ).toEqual(['orca-cli'])
  })

  it('judges each requested name independently', () => {
    expect(
      skillUpdateFailedNames(
        ['orca-cli', 'orchestration'],
        [placement('orca-cli', 'current'), placement('orchestration', 'outdated')]
      )
    ).toEqual(['orchestration'])
  })
})
