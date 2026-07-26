import { describe, expect, it } from 'vitest'
import {
  buildTargetedSkillUpdateCommand,
  type SkillFreshnessInstallation
} from '../../shared/skill-freshness'
import { eligibleSkillUpdateNames } from './skill-freshness-eligibility'

function placement(
  name: string,
  overrides: Partial<SkillFreshnessInstallation> = {}
): SkillFreshnessInstallation {
  return {
    id: `${name}-${overrides.rootId ?? 'home-agents'}`,
    name,
    rootId: 'home-agents',
    providers: ['agent-skills'],
    sourceKind: 'home',
    sourceLabel: 'Agent skills home',
    unresolvedPath: `/home/.agents/skills/${name}`,
    resolvedPath: `/home/.agents/skills/${name}`,
    physicalIdentity: `physical-${name}`,
    topology: 'canonical-copy',
    status: 'outdated',
    installedReleaseRevision: 1,
    installedAppVersion: '1.0.0',
    currentReleaseRevision: 2,
    currentPackageDigest: 'current',
    currentAppVersion: '2.0.0',
    observedPackageDigest: 'old',
    errorCategory: null,
    ...overrides
  }
}

describe('skill freshness name-scoped update eligibility', () => {
  it('offers a name when at least one supported placement is outdated and all are official', () => {
    expect(
      eligibleSkillUpdateNames([
        placement('orca-cli'),
        placement('orca-cli', {
          id: 'orca-cli-claude',
          rootId: 'home-claude',
          topology: 'provider-alias',
          status: 'current'
        })
      ])
    ).toEqual(['orca-cli'])
  })

  it.each([
    ['newer-known', 'independent-copy'],
    ['unrecognized', 'independent-copy'],
    ['inaccessible', 'broken-link'],
    ['current', 'external-link'],
    ['current', 'read-only'],
    ['current', 'repo-scope'],
    ['current', 'plugin-cache']
  ] as const)(
    'still updates the canonical copy despite a %s placement in %s topology',
    (status, topology) => {
      // Why: `--global` provably never writes these placements, so withholding the
      // update over one refuses work the command could do to a copy that is never at
      // stake. The canonical copy converges and the outlier is reported separately.
      expect(
        eligibleSkillUpdateNames([
          placement('orca-cli'),
          placement('orca-cli', { id: `outlier-${status}-${topology}`, status, topology })
        ])
      ).toEqual(['orca-cli'])
    }
  )

  it.each(['unrecognized', 'inaccessible', 'newer-known'] as const)(
    'withholds the update when the convergent copy itself is %s',
    (status) => {
      // Why: this is the placement the command writes to, so overwriting it is the
      // real data-loss case the rail exists to avoid.
      expect(
        eligibleSkillUpdateNames([
          placement('orca-cli', { id: 'blocked-canonical', status }),
          placement('orca-cli', {
            id: 'orca-cli-claude',
            rootId: 'home-claude',
            topology: 'provider-alias',
            status: 'outdated'
          })
        ])
      ).toEqual([])
    }
  )

  it('still updates the canonical copy when a clean standalone duplicate exists', () => {
    // Why: a duplicate no longer omits the whole name — the canonical copy converges
    // and the duplicate row is flagged as maybe-not-reached rather than blocking.
    expect(
      eligibleSkillUpdateNames([
        placement('orca-cli'),
        placement('orca-cli', {
          id: 'orca-cli-gemini',
          rootId: 'home-gemini',
          unresolvedPath: '/home/.gemini/skills/orca-cli',
          resolvedPath: '/home/.gemini/skills/orca-cli',
          topology: 'independent-copy',
          status: 'current'
        })
      ])
    ).toEqual(['orca-cli'])
  })

  it('does not promise an update when only an unreachable duplicate is outdated', () => {
    // Why: `--global` converges the canonical copy and its aliases only. Offering the
    // name here advertises an update the command reports as already up to date, so the
    // badge could never clear; the dialog explains the duplicate as skipped instead.
    expect(
      eligibleSkillUpdateNames([
        placement('orchestration', { status: 'current' }),
        placement('orchestration', {
          id: 'orchestration-factory',
          rootId: 'home-factory',
          unresolvedPath: '/home/.factory/skills/orchestration',
          resolvedPath: '/home/.factory/skills/orchestration',
          physicalIdentity: 'physical-orchestration-factory',
          topology: 'independent-copy',
          status: 'outdated'
        })
      ])
    ).toEqual([])
  })

  it('does not offer a skill that exists only as a standalone copy', () => {
    // Why: with no canonical or alias to anchor `--global`, the command has no
    // reliable target, so a duplicate-only skill stays unoffered.
    expect(
      eligibleSkillUpdateNames([
        placement('orca-cli', {
          rootId: 'home-gemini',
          unresolvedPath: '/home/.gemini/skills/orca-cli',
          resolvedPath: '/home/.gemini/skills/orca-cli',
          topology: 'independent-copy',
          status: 'outdated'
        })
      ])
    ).toEqual([])
  })

  it('scopes each name independently and leaves an all-current name alone', () => {
    // Why: a project copy is never written by `--global`, so it does not speak for
    // the global one — while a name whose convergent copy is current stays unoffered.
    expect(
      eligibleSkillUpdateNames([
        placement('computer-use', { status: 'current' }),
        placement('orchestration'),
        placement('orchestration', {
          id: 'orchestration-project',
          status: 'unrecognized',
          topology: 'repo-scope'
        })
      ])
    ).toEqual(['orchestration'])
  })

  it('builds only an explicit, deterministic global command', () => {
    expect(buildTargetedSkillUpdateCommand(['orchestration', 'orca-cli', 'orca-cli'])).toBe(
      'npx skills update orca-cli orchestration --global'
    )
    expect(buildTargetedSkillUpdateCommand([])).toBeNull()
    expect(buildTargetedSkillUpdateCommand(['orca-cli;echo unsafe'])).toBeNull()
  })
})
