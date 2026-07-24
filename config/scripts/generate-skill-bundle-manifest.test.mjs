import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  appendReleaseRow,
  assertReleasedHistoryPreserved,
  classifyFile,
  collectPackageFiles,
  describeFile,
  gitTreeSha,
  isToleratedReleaseMappingPrefix,
  normalizeText,
  packageDigest,
  releasedHistoryFromCommitted,
  sortManifestFiles
} from './generate-skill-bundle-manifest.mjs'

const temporaryDirectories = []

async function createPackage() {
  const directory = await mkdtemp(path.join(tmpdir(), 'orca-skill-manifest-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true }))
  )
})

describe('skill bundle manifest generator', () => {
  it('folds platform line endings for text identity', () => {
    const lf = Buffer.from('first\nsecond\n')
    const crlf = Buffer.from('first\r\nsecond\r\n')

    expect(classifyFile(lf)).toBe('text')
    expect(normalizeText(crlf)).toEqual(lf)
  })

  it('classifies null-containing and invalid UTF-8 content as binary', () => {
    expect(classifyFile(Buffer.from([0, 1, 2]))).toBe('binary')
    expect(classifyFile(Buffer.from([0xc3, 0x28]))).toBe('binary')
  })

  it('uses normalized text identity but exact executable identity', () => {
    const skillFile = describeFile('SKILL.md', Buffer.from('line one\r\nline two\r\n'), false)
    const executable = describeFile('run.sh', Buffer.from('#!/bin/sh\r\necho ok\r\n'), true)

    expect(skillFile.identitySha256).toBe(skillFile.textNormalizedSha256)
    expect(skillFile.identitySha256).not.toBe(skillFile.exactSha256)
    expect(executable.exactSha256).not.toBe(executable.textNormalizedSha256)
    expect(executable.identitySha256).toBe(executable.exactSha256)
    expect(packageDigest([skillFile, executable])).toMatch(/^[a-f0-9]{64}$/)
  })

  it('orders git-history files identically to the filesystem walk', async () => {
    const packageRoot = await createPackage()
    await mkdir(path.join(packageRoot, 'sub'))
    for (const name of ['apple.md', 'sub.md', 'Zebra.md', path.join('sub', 'inner.txt')]) {
      await writeFile(path.join(packageRoot, name), `${name}\n`)
    }
    const walked = await collectPackageFiles(packageRoot)

    // Why: git ls-tree emits [Zebra.md, apple.md, sub.md, sub/inner.txt]; index-based
    // snapshot matching requires history and observation to share one order.
    const gitOrdered = ['Zebra.md', 'apple.md', 'sub.md', 'sub/inner.txt'].map((manifestPath) =>
      walked.find((file) => file.path === manifestPath)
    )

    expect(sortManifestFiles(gitOrdered)).toEqual(walked)
    expect(packageDigest(sortManifestFiles(gitOrdered))).toBe(packageDigest(walked))
    expect(walked.map((file) => file.path)).toEqual([
      'Zebra.md',
      'apple.md',
      'sub/inner.txt',
      'sub.md'
    ])
  })

  it('rejects rewrites of released snapshots and allows floating-tail replacement', () => {
    const snapshot = (releaseRevision, packageDigest) => ({ releaseRevision, packageDigest })
    const artifacts = {
      releasedSnapshotCounts: { 'orca-cli': 2 },
      snapshotRegistry: {
        schemaVersion: 1,
        skills: { 'orca-cli': [snapshot(1, 'aaa'), snapshot(2, 'bbb'), snapshot(3, 'ccc')] }
      }
    }

    expect(() =>
      assertReleasedHistoryPreserved(
        { schemaVersion: 1, skills: { 'orca-cli': [snapshot(1, 'aaa'), snapshot(2, 'bbb')] } },
        artifacts
      )
    ).not.toThrow()
    expect(() =>
      assertReleasedHistoryPreserved(
        {
          schemaVersion: 1,
          skills: { 'orca-cli': [snapshot(1, 'aaa'), snapshot(2, 'bbb'), snapshot(3, 'stale')] }
        },
        artifacts
      )
    ).not.toThrow()
    expect(() =>
      assertReleasedHistoryPreserved(
        {
          schemaVersion: 1,
          skills: { 'orca-cli': [snapshot(1, 'aaa'), snapshot(2, 'rewritten')] }
        },
        artifacts
      )
    ).toThrow('Released snapshot history changed for orca-cli at revision 2')
    expect(() =>
      assertReleasedHistoryPreserved(
        {
          schemaVersion: 1,
          skills: {
            'orca-cli': [snapshot(1, 'aaa'), { ...snapshot(2, 'bbb'), gitTreeSha: 'rewritten' }]
          }
        },
        artifacts
      )
    ).toThrow('Released snapshot history changed for orca-cli at revision 2')
    expect(() =>
      assertReleasedHistoryPreserved(
        {
          schemaVersion: 1,
          skills: {
            'orca-cli': [snapshot(1, 'aaa'), snapshot(2, 'bbb'), snapshot(3, 'stale')]
          }
        },
        { ...artifacts, releasedSnapshotCounts: { 'orca-cli': 1 } }
      )
    ).toThrow('Released snapshot history is incomplete for orca-cli')
    expect(() => assertReleasedHistoryPreserved(null, artifacts)).not.toThrow()
  })

  it('protects only revisions named by the committed release mapping', () => {
    const snapshot = (releaseRevision, packageDigest) => ({ releaseRevision, packageDigest })
    const committedRegistry = {
      schemaVersion: 1,
      skills: {
        'linear-tickets': [snapshot(1, 'released'), snapshot(2, 'unreleased-tail')]
      }
    }
    const artifacts = {
      releasedSnapshotCounts: { 'linear-tickets': 2 },
      snapshotRegistry: {
        schemaVersion: 1,
        skills: { 'linear-tickets': [snapshot(1, 'released'), snapshot(2, 'new-release')] }
      }
    }

    expect(() =>
      assertReleasedHistoryPreserved(committedRegistry, artifacts, {
        schemaVersion: 1,
        releases: [{ appVersion: '1.0.0', skills: { 'linear-tickets': 1 } }]
      })
    ).not.toThrow()
    expect(() =>
      assertReleasedHistoryPreserved(committedRegistry, artifacts, {
        schemaVersion: 1,
        releases: [{ appVersion: '1.0.0', skills: { 'linear-tickets': 2 } }]
      })
    ).toThrow('Released snapshot history changed for linear-tickets at revision 2')
  })

  it('tolerates only redundant trailing release-mapping rows', () => {
    const serialized = (value) => `${JSON.stringify(value, null, 2)}\n`
    const rows = [
      { appVersion: '1.0.0', skills: { 'orca-cli': 1 } },
      { appVersion: '1.1.0', skills: { 'orca-cli': 2 } }
    ]
    const artifacts = {
      currentManifest: { skills: [{ name: 'orca-cli', releaseRevision: 2 }] },
      releaseMapping: { schemaVersion: 1, releases: rows }
    }
    const committedPrefix = serialized({ schemaVersion: 1, releases: [rows[0]] })

    // A just-cut tag whose bytes equal the working tree may lag in the mapping.
    expect(isToleratedReleaseMappingPrefix(committedPrefix, artifacts)).toBe(true)
    // The committed file matching the derived mapping is byte-equality's job, not tolerance.
    expect(isToleratedReleaseMappingPrefix(serialized(artifacts.releaseMapping), artifacts)).toBe(
      false
    )
    // A trailing row for bytes the committed artifacts do not describe is a real gap.
    expect(
      isToleratedReleaseMappingPrefix(committedPrefix, {
        ...artifacts,
        currentManifest: { skills: [{ name: 'orca-cli', releaseRevision: 3 }] }
      })
    ).toBe(false)
    expect(
      isToleratedReleaseMappingPrefix(committedPrefix, {
        ...artifacts,
        currentManifest: {
          skills: [
            { name: 'orca-cli', releaseRevision: 2 },
            { name: 'orca-linear', releaseRevision: 1 }
          ]
        }
      })
    ).toBe(false)
    // Rewritten earlier rows never pass, with or without trailing rows.
    expect(
      isToleratedReleaseMappingPrefix(
        serialized({
          schemaVersion: 1,
          releases: [{ appVersion: '0.9.0', skills: { 'orca-cli': 1 } }]
        }),
        artifacts
      )
    ).toBe(false)
    expect(isToleratedReleaseMappingPrefix('not json', artifacts)).toBe(false)
    expect(isToleratedReleaseMappingPrefix(serialized({ schemaVersion: 1 }), artifacts)).toBe(false)
  })

  it('seeds released history from the committed ledger and drops the floating tail', () => {
    const snapshot = (releaseRevision, packageDigest) => ({ releaseRevision, packageDigest })
    const committedRegistry = {
      schemaVersion: 1,
      skills: {
        // released revs 1..2 named by the mapping, plus an unreleased tail at 3
        'orca-cli': [snapshot(1, 'aaa'), snapshot(2, 'bbb'), snapshot(3, 'unreleased')],
        // no mapping row -> fall back to all-but-tail
        'orca-linear': [snapshot(1, 'ccc'), snapshot(2, 'tail')]
      }
    }
    const committedMapping = {
      schemaVersion: 1,
      releases: [{ appVersion: '1.0.0', skills: { 'orca-cli': 2 } }]
    }

    const seeded = releasedHistoryFromCommitted(committedRegistry, committedMapping)

    // The unreleased tail is dropped; only mapping-named revisions survive.
    expect(seeded.registry.skills['orca-cli']).toEqual([snapshot(1, 'aaa'), snapshot(2, 'bbb')])
    expect(seeded.registry.skills['orca-linear']).toEqual([snapshot(1, 'ccc')])
    expect(seeded.releasedSnapshotCounts).toEqual({ 'orca-cli': 2, 'orca-linear': 1 })
    // The seed clones the mapping so a later release append cannot alias committed state.
    expect(seeded.mapping).toEqual(committedMapping)
    expect(seeded.mapping).not.toBe(committedMapping)
  })

  it('returns an empty ledger when no committed artifacts exist', () => {
    const seeded = releasedHistoryFromCommitted(null, null)
    expect(seeded.registry.skills).toEqual({})
    expect(seeded.releasedSnapshotCounts).toEqual({})
    expect(seeded.mapping.releases).toEqual([])
  })

  it('appends one release row, stripping the v-prefix and deduping identical tails', () => {
    const artifacts = {
      currentManifest: {
        skills: [
          { name: 'orca-cli', releaseRevision: 36 },
          { name: 'orca-linear', releaseRevision: 8 }
        ]
      },
      releaseMapping: {
        schemaVersion: 1,
        releases: [{ appVersion: '1.4.151', skills: { 'orca-cli': 35, 'orca-linear': 8 } }]
      }
    }

    appendReleaseRow(artifacts, 'v1.4.160')
    expect(artifacts.releaseMapping.releases.at(-1)).toEqual({
      appVersion: '1.4.160',
      skills: { 'orca-cli': 36, 'orca-linear': 8 }
    })

    // A second release over identical revisions adds no row.
    appendReleaseRow(artifacts, '1.4.161')
    expect(artifacts.releaseMapping.releases).toHaveLength(2)
  })

  it('overwrites the trailing row when a failed cut is re-cut at the same version', () => {
    const artifacts = {
      currentManifest: { skills: [{ name: 'orca-cli', releaseRevision: 37 }] },
      releaseMapping: {
        schemaVersion: 1,
        releases: [
          { appVersion: '1.4.151', skills: { 'orca-cli': 35 } },
          // The failed cut already pushed this row to main at revision 36.
          { appVersion: '1.4.160', skills: { 'orca-cli': 36 } }
        ]
      }
    }

    appendReleaseRow(artifacts, '1.4.160')

    // One row per version: the tag ships revision 37, so 36 must not linger.
    expect(artifacts.releaseMapping.releases).toEqual([
      { appVersion: '1.4.151', skills: { 'orca-cli': 35 } },
      { appVersion: '1.4.160', skills: { 'orca-cli': 37 } }
    ])
  })

  it('refuses to rewrite an already-shipped version behind the trailing row', () => {
    const artifacts = {
      currentManifest: { skills: [{ name: 'orca-cli', releaseRevision: 37 }] },
      releaseMapping: {
        schemaVersion: 1,
        releases: [
          { appVersion: '1.4.151', skills: { 'orca-cli': 35 } },
          { appVersion: '1.4.160', skills: { 'orca-cli': 36 } }
        ]
      }
    }

    expect(() => appendReleaseRow(artifacts, '1.4.151')).toThrow(/already has a row for 1\.4\.151/)
  })

  it.runIf(process.platform !== 'win32')(
    'rejects executable files in shipped skill packages',
    async () => {
      const packageRoot = await createPackage()
      await writeFile(path.join(packageRoot, 'SKILL.md'), 'skill\n')
      await writeFile(path.join(packageRoot, 'run.sh'), '#!/bin/sh\necho ok\n')
      await chmod(path.join(packageRoot, 'run.sh'), 0o755)

      await expect(collectPackageFiles(packageRoot)).rejects.toThrow(
        'Executable file is not allowed in a shipped skill: run.sh'
      )
    }
  )

  it.runIf(process.platform === 'linux')('rejects case-colliding paths', async () => {
    const packageRoot = await createPackage()
    await writeFile(path.join(packageRoot, 'SKILL.md'), 'skill')
    await writeFile(path.join(packageRoot, 'Readme.md'), 'one')
    await writeFile(path.join(packageRoot, 'README.md'), 'two')

    await expect(collectPackageFiles(packageRoot)).rejects.toThrow('Case-colliding skill paths')
  })

  it.runIf(process.platform !== 'win32')('rejects symlinks inside shipped packages', async () => {
    const packageRoot = await createPackage()
    await writeFile(path.join(packageRoot, 'SKILL.md'), 'skill')
    await symlink('SKILL.md', path.join(packageRoot, 'linked.md'))

    await expect(collectPackageFiles(packageRoot)).rejects.toThrow(
      'Symlink is not allowed in a shipped skill'
    )
  })

  it('computes the same Git tree identity as Git', async () => {
    const packageRoot = path.resolve('skills', 'orca-cli')
    const files = await collectPackageFiles(packageRoot)
    const expected = execFileSync('git', ['ls-tree', 'HEAD:skills', 'orca-cli'], {
      encoding: 'utf8'
    })
      .trim()
      .split(/\s+/)[2]

    expect(gitTreeSha(files)).toBe(expected)
  })

  it('matches Git when a directory and file share a name prefix', async () => {
    const packageRoot = await createPackage()
    await mkdir(path.join(packageRoot, 'sub'))
    await writeFile(path.join(packageRoot, 'sub', 'inner.txt'), 'nested\n')
    await writeFile(path.join(packageRoot, 'sub.md'), 'sibling\n')
    const files = await collectPackageFiles(packageRoot)
    execFileSync('git', ['init', '--quiet'], { cwd: packageRoot })
    execFileSync('git', ['add', '-A'], { cwd: packageRoot })
    const expected = execFileSync('git', ['write-tree'], {
      cwd: packageRoot,
      encoding: 'utf8'
    }).trim()

    expect(gitTreeSha(files)).toBe(expected)
  })
})
