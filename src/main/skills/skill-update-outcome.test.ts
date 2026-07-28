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
    installedReleaseRevision: 2,
    installedAppVersion: '2.0.0',
    currentReleaseRevision: 2,
    currentPackageDigest: 'current',
    currentAppVersion: '2.0.0',
    observedPackageDigest: 'current',
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

  it('reports a half-written bundle instead of reading it as success', () => {
    // The old "still eligible?" test passed here: an unrecognized copy is not
    // eligible either, so a corrupt write looked identical to a clean update.
    expect(skillUpdateFailedNames(['orca-cli'], [placement('orca-cli', 'unrecognized')])).toEqual([
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

  it('accepts a revision newer than this build ships', () => {
    // The CLI pulls from the source repo, which runs ahead of the bundled manifest.
    expect(skillUpdateFailedNames(['orca-cli'], [placement('orca-cli', 'newer-known')])).toEqual([])
  })

  it('ignores placements the update command never writes to', () => {
    expect(
      skillUpdateFailedNames(
        ['orca-cli'],
        [placement('orca-cli', 'current'), placement('orca-cli', 'outdated', 'plugin-cache')]
      )
    ).toEqual([])
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
