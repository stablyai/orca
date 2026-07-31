import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  describeObservedSkillFile,
  matchingKnownSnapshot,
  observeSkillPackage,
  skillPackageDigest
} from './skill-package-identity'

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

  it('ignores OS-authored sidecars so a browsed folder still matches its snapshot', async () => {
    const pristine = await temporarySkill()
    await writeFile(join(pristine, 'SKILL.md'), 'skill\n')
    const official = await observeSkillPackage(pristine)

    const browsed = await temporarySkill()
    await writeFile(join(browsed, 'SKILL.md'), 'skill\n')
    // Every name the OS writes on its own, including one that sorts BEFORE SKILL.md —
    // the index-aligned comparison in matchingKnownSnapshot misaligns on a leading entry,
    // so a trailing-name-only fixture would pass while the reported bug survived.
    await writeFile(join(browsed, '.DS_Store'), Buffer.from([0, 1, 2, 3]))
    await writeFile(join(browsed, '._SKILL.md'), Buffer.from([0, 5]))
    await writeFile(join(browsed, 'Thumbs.db'), Buffer.from([9]))
    await writeFile(join(browsed, 'desktop.ini'), '[.ShellClassInfo]\n')

    const observed = await observeSkillPackage(browsed)

    expect(observed.files.map((file) => file.path)).toEqual(['SKILL.md'])
    // The lock-trust path compares this against the updater's recorded source tree, so it
    // has to come out clean too, not just the digest.
    expect(observed.observedGitTreeSha).toBe(official.observedGitTreeSha)
    expect(
      matchingKnownSnapshot(observed, [
        {
          releaseRevision: 1,
          packageDigest: official.observedDigest,
          gitTreeSha: official.observedGitTreeSha,
          files: official.files
        }
      ])?.releaseRevision
    ).toBe(1)
  })

  it('keeps guarding a directory or link that only wears an OS metadata name', async () => {
    const root = await temporarySkill()
    await writeFile(join(root, 'SKILL.md'), 'skill\n')
    // The OS writes these names as plain files only, so a subtree behind one is real content:
    // dropping it on the name alone would hide it from identity and read as pristine.
    await mkdir(join(root, '._scripts'))
    await writeFile(join(root, '._scripts', 'payload.sh'), '#!/bin/sh\n')

    expect((await observeSkillPackage(root)).files.map((file) => file.path)).toEqual([
      '._scripts/payload.sh',
      'SKILL.md'
    ])

    if (process.platform !== 'win32') {
      await rm(join(root, '._scripts'), { recursive: true })
      await symlink(join(root, 'SKILL.md'), join(root, '._DS_Store'))
      await expect(observeSkillPackage(root)).rejects.toThrow('skill-package-link')
    }
  })

  it('still reports a genuinely modified skill as unmatched', async () => {
    const pristine = await temporarySkill()
    await writeFile(join(pristine, 'SKILL.md'), 'skill\n')
    const official = await observeSkillPackage(pristine)

    const edited = await temporarySkill()
    await writeFile(join(edited, 'SKILL.md'), 'skill\nlocal tweak\n')
    await writeFile(join(edited, '.DS_Store'), Buffer.from([0, 1]))
    // An unexpected file that is NOT OS metadata must keep failing closed; tolerating
    // extras in general would let an injected payload ride along beside a clean SKILL.md.
    const withPayload = await temporarySkill()
    await writeFile(join(withPayload, 'SKILL.md'), 'skill\n')
    await writeFile(join(withPayload, 'payload.sh'), '#!/bin/sh\n')

    const snapshot = [
      {
        releaseRevision: 1,
        packageDigest: official.observedDigest,
        gitTreeSha: official.observedGitTreeSha,
        files: official.files
      }
    ]
    expect(matchingKnownSnapshot(await observeSkillPackage(edited), snapshot)).toBeNull()
    expect(matchingKnownSnapshot(await observeSkillPackage(withPayload), snapshot)).toBeNull()
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
