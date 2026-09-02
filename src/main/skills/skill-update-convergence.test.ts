import { describe, expect, it } from 'vitest'
import type { SkillFreshnessInstallation, SkillKnownSnapshot } from '../../shared/skill-freshness'
import { convergableSkillNames } from './skill-update-convergence'

// `installedReleaseRevision` is the revision observation resolved this copy to, and
// null is the honest "readable, but matching nothing we know". A null
// `observedPackageDigest` is the different case of a copy that could not be read.
//
// The digest defaults to the resolved revision's own, so these fixtures describe a
// folder holding nothing but official files. That keeps the revert signal honest:
// swapping resolution back to a digest lookup still passes every case below except
// the sidecar one, which is the only case that distinguishes the two mechanisms.
function placement(
  name: string,
  installedReleaseRevision: number | null,
  topology: SkillFreshnessInstallation['topology'] = 'canonical-copy',
  observedPackageDigest: string | null = `digest-${installedReleaseRevision}`
): SkillFreshnessInstallation {
  return {
    id: `${name}:${installedReleaseRevision}:${topology}`,
    name,
    rootId: 'home',
    providers: [],
    sourceKind: 'home',
    sourceLabel: 'home',
    unresolvedPath: `~/.agents/skills/${name}`,
    resolvedPath: `/home/u/.agents/skills/${name}`,
    physicalIdentity: '1:1',
    topology,
    status: 'outdated',
    installedReleaseRevision,
    installedAppVersion: null,
    currentReleaseRevision: 8,
    currentPackageDigest: 'digest-current',
    currentAppVersion: '1.4.160',
    observedPackageDigest,
    errorCategory: null
  }
}

function revision(releaseRevision: number, gitTreeSha: string): SkillKnownSnapshot {
  return { releaseRevision, packageDigest: `digest-${releaseRevision}`, gitTreeSha, files: [] }
}

const PRE_STUB = revision(1, 'f3727995')
const STUB = revision(2, '091d9bcc')

describe('convergableSkillNames', () => {
  // The real reported case: the lock records the stub tree (091d9bcc) while disk
  // still holds the pre-stub revision (f3727995). `skills update` compares lock to
  // source, sees no work, exits 0 and writes nothing — forever.
  it('drops a skill whose lock records a revision the disk does not have', () => {
    const result = convergableSkillNames(
      [placement('orca-linear', 1)],
      new Map([['orca-linear', '091d9bcc']]),
      { 'orca-linear': [PRE_STUB, STUB] }
    )
    expect([...result]).toEqual([])
  })

  // The legitimate case that must NOT be gated: lock and disk agree, and the source
  // has simply moved ahead of what this build bundles. The update really can converge.
  it('keeps a skill whose lock matches disk even when it is outdated', () => {
    const result = convergableSkillNames(
      [placement('orca-cli', 1)],
      new Map([['orca-cli', 'aaaa1111']]),
      { 'orca-cli': [revision(1, 'aaaa1111')] }
    )
    expect([...result]).toEqual(['orca-cli'])
  })

  it('keeps a skill whose disk content matches no known revision', () => {
    const result = convergableSkillNames(
      [placement('orca-cli', null)],
      new Map([['orca-cli', 'aaaa1111']]),
      { 'orca-cli': [revision(1, 'bbbb2222')] }
    )
    expect([...result]).toEqual(['orca-cli'])
  })

  it('keeps a skill with no observable placement', () => {
    const result = convergableSkillNames(
      [placement('orca-cli', null, 'canonical-copy', null)],
      new Map([['orca-cli', 'aaaa1111']]),
      { 'orca-cli': [revision(1, 'aaaa1111')] }
    )
    expect([...result]).toEqual(['orca-cli'])
  })

  // Why: a sidecar an agent CLI dropped beside the official files makes the folder
  // digest match no revision at all, so resolving disk content by that digest would
  // read as unidentifiable and quietly re-arm the unwinnable update. Observation
  // already placed this copy at the pre-stub revision; the gate must honour that.
  it('drops a stale skill whose folder holds files no revision lists', () => {
    const result = convergableSkillNames(
      [placement('orca-linear', 1, 'canonical-copy', 'digest-with-sidecar')],
      new Map([['orca-linear', '091d9bcc']]),
      { 'orca-linear': [PRE_STUB, STUB] }
    )
    expect([...result]).toEqual([])
  })

  // One placement still matching the lock means the command has an anchor to write.
  it('keeps a skill when any placement still matches the lock', () => {
    const result = convergableSkillNames(
      [placement('orca-cli', 1), placement('orca-cli', 2)],
      new Map([['orca-cli', 'aaaa1111']]),
      { 'orca-cli': [revision(1, 'aaaa1111'), revision(2, 'f3727995')] }
    )
    expect([...result]).toEqual(['orca-cli'])
  })

  // A lock hash we cannot place is not evidence the command is stuck.
  it('keeps a skill whose lock names no revision we know', () => {
    const result = convergableSkillNames(
      [placement('orca-cli', 1)],
      new Map([['orca-cli', 'not-a-known-tree']]),
      { 'orca-cli': [revision(1, 'f3727995')] }
    )
    expect([...result]).toEqual(['orca-cli'])
  })

  // Why: `diskTreeShas` silently drops placements that resolved to nothing, so a
  // stale copy sitting beside an unidentifiable one must NOT gate the name — the
  // unknown half could be anything, including a copy the command would converge.
  it('keeps a skill when one placement is stale but another is unidentifiable', () => {
    const result = convergableSkillNames(
      [placement('orca-cli', 1), placement('orca-cli', null)],
      new Map([['orca-cli', '091d9bcc']]),
      { 'orca-cli': [PRE_STUB, STUB] }
    )
    expect([...result]).toEqual(['orca-cli'])
  })

  // Why: copies the command never writes must not defeat the gate. An
  // unidentifiable plugin-cache repack would otherwise read as an unresolved
  // placement and re-arm the unwinnable update on the drifted canonical.
  it('ignores an unidentifiable plugin-cache copy when judging the canonical', () => {
    const result = convergableSkillNames(
      [placement('orca-linear', 1), placement('orca-linear', null, 'plugin-cache')],
      new Map([['orca-linear', '091d9bcc']]),
      { 'orca-linear': [PRE_STUB, STUB] }
    )
    expect([...result]).toEqual([])
  })

  // A cache copy parked at the lock's own revision is not an anchor either —
  // the command only writes the canonical, which is still drifted.
  it('ignores a plugin-cache copy that matches the lock', () => {
    const result = convergableSkillNames(
      [placement('orca-linear', 1), placement('orca-linear', 2, 'plugin-cache')],
      new Map([['orca-linear', '091d9bcc']]),
      { 'orca-linear': [PRE_STUB, STUB] }
    )
    expect([...result]).toEqual([])
  })

  it('judges each locked skill independently', () => {
    const result = convergableSkillNames(
      [placement('orca-linear', 1), placement('orca-cli', 1)],
      new Map([
        ['orca-linear', '091d9bcc'],
        ['orca-cli', 'aaaa1111']
      ]),
      {
        'orca-linear': [PRE_STUB, STUB],
        'orca-cli': [revision(1, 'aaaa1111')]
      }
    )
    expect([...result]).toEqual(['orca-cli'])
  })
})
