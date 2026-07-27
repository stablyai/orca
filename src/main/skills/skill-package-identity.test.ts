import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  describeObservedSkillFile,
  matchingKnownSnapshot,
  observeSkillPackage,
  sharesKnownSnapshotFileIdentity,
  skillPackageDigest
} from './skill-package-identity'
import type { SkillKnownSnapshot } from '../../shared/skill-freshness'

const temporaryDirectories: string[] = []

async function temporarySkill(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-skill-freshness-'))
  temporaryDirectories.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((root) => rm(root, { recursive: true })))
})

describe('skill package identity', () => {
  it('matches CRLF installed text to an LF official snapshot', async () => {
    const root = await temporarySkill()
    await writeFile(join(root, 'SKILL.md'), 'first\r\nsecond\r\n')
    const observed = await observeSkillPackage(root)
    const expected = describeObservedSkillFile('SKILL.md', Buffer.from('first\nsecond\n'), false)

    // Why: scans can observe several package byte budgets concurrently; only
    // hashes, not raw file buffers, should survive each file's identity pass.
    expect(observed.files[0]).not.toHaveProperty('bytes')
    expect(
      matchingKnownSnapshot(observed, [
        {
          releaseRevision: 1,
          packageDigest: skillPackageDigest([expected]),
          gitTreeSha: 'tree',
          files: [expected]
        }
      ])?.releaseRevision
    ).toBe(1)
  })

  it('uses exact bytes for executable and binary files', async () => {
    const executable = describeObservedSkillFile('run.sh', Buffer.from('#!/bin/sh\r\n'), true)
    const binary = describeObservedSkillFile('asset.bin', Buffer.from([0, 13, 10]), false)
    expect(executable.identitySha256).toBe(executable.exactSha256)
    expect(binary.identitySha256).toBe(binary.exactSha256)
    expect(binary.classification).toBe('binary')
  })

  it('orders package files by locale-independent code units', async () => {
    const root = await temporarySkill()
    await writeFile(join(root, 'apple.md'), 'apple')
    await writeFile(join(root, 'Zebra.md'), 'zebra')

    const observed = await observeSkillPackage(root)

    expect(observed.files.map((file) => file.path)).toEqual(['Zebra.md', 'apple.md'])
  })

  it('rejects links and bounded-observation overflows', async () => {
    const root = await temporarySkill()
    await writeFile(join(root, 'SKILL.md'), 'skill')
    if (process.platform !== 'win32') {
      await symlink(join(root, 'SKILL.md'), join(root, 'linked.md'))
      await expect(observeSkillPackage(root)).rejects.toThrow('skill-package-link')
      await rm(join(root, 'linked.md'))
    }
    await expect(
      observeSkillPackage(root, {
        maximumDepth: 1,
        maximumEntries: 0,
        maximumFiles: 1,
        maximumSingleFileBytes: 10,
        maximumTotalBytes: 10
      })
    ).rejects.toThrow('skill-package-entry-limit')
  })

  it.runIf(process.platform !== 'win32')('tracks executable mode in package identity', async () => {
    const root = await temporarySkill()
    await mkdir(join(root, 'scripts'))
    const script = join(root, 'scripts', 'run.sh')
    await writeFile(script, '#!/bin/sh\n')
    await chmod(script, 0o755)
    const observed = await observeSkillPackage(root)
    expect(observed.files[0]?.executable).toBe(true)
  })
})

describe('sharesKnownSnapshotFileIdentity', () => {
  function officialFile(path: string, text: string) {
    return describeObservedSkillFile(path, Buffer.from(text), false)
  }

  function officialSnapshot(files: ReturnType<typeof officialFile>[]): SkillKnownSnapshot {
    return {
      releaseRevision: 1,
      packageDigest: skillPackageDigest(files),
      gitTreeSha: '0'.repeat(40),
      files
    }
  }

  const snapshots = [
    officialSnapshot([
      officialFile('SKILL.md', 'official guide'),
      officialFile('run.sh', 'echo hi')
    ])
  ]

  it('keeps an edited official copy attributable through its untouched files', async () => {
    const root = await temporarySkill()
    await writeFile(join(root, 'SKILL.md'), 'official guide, with my notes')
    await writeFile(join(root, 'run.sh'), 'echo hi')
    expect(sharesKnownSnapshotFileIdentity(await observeSkillPackage(root), snapshots)).toBe(true)
  })

  it('finds no descent in a package that shares only the name', async () => {
    const root = await temporarySkill()
    await writeFile(join(root, 'SKILL.md'), 'a different tool’s skill')
    await writeFile(join(root, 'client.mjs'), 'export const run = () => {}')
    expect(sharesKnownSnapshotFileIdentity(await observeSkillPackage(root), snapshots)).toBe(false)
  })

  it('requires the same path, so identical bytes filed elsewhere are not descent', async () => {
    const root = await temporarySkill()
    await writeFile(join(root, 'COPIED.md'), 'official guide')
    expect(sharesKnownSnapshotFileIdentity(await observeSkillPackage(root), snapshots)).toBe(false)
  })

  it('reports nothing shared for an empty package', async () => {
    expect(
      sharesKnownSnapshotFileIdentity(await observeSkillPackage(await temporarySkill()), snapshots)
    ).toBe(false)
  })
})
