import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { createSkillPackageArchive } from './skill-package-creation'
import { extractSkillPackageArchive } from './skill-package-extraction'

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'orca-skill-package-test-'))
  temporaryDirectories.push(directory)
  return directory
}

async function createSkill(root: string): Promise<string> {
  const skill = join(root, 'test-skill')
  await mkdir(join(skill, 'scripts'), { recursive: true })
  await writeFile(
    join(skill, 'SKILL.md'),
    '---\nname: test-skill\ndescription: A private test skill\n---\n\n# Test\n'
  )
  await writeFile(join(skill, 'scripts', 'run.sh'), '#!/bin/sh\necho test\n')
  await chmod(join(skill, 'scripts', 'run.sh'), 0o755)
  return skill
}

async function mutateArchive(
  source: string,
  target: string,
  mutate: (tar: Buffer) => Buffer | void
): Promise<void> {
  const tar = gunzipSync(await readFile(source))
  const mutated = mutate(tar) ?? tar
  await writeFile(target, gzipSync(mutated, { level: 9 }))
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true }))
  )
})

describe('skill package creation and extraction', () => {
  it('round trips a validated skill and preserves observed executable identity', async () => {
    const root = await temporaryDirectory()
    const sourceDirectory = await createSkill(root)
    const archivePath = join(root, 'package.tar.gz')
    const created = await createSkillPackageArchive({
      sourceDirectory,
      archivePath,
      packageId: 'package_1',
      versionId: 'version_1',
      createdAt: '2026-08-11T12:00:00.000Z'
    })

    const extracted = await extractSkillPackageArchive({
      archivePath,
      destinationDirectory: join(root, 'extracted'),
      expectedArchiveSha256: created.archiveSha256,
      expectedPackageDigest: created.manifest.packageDigest
    })

    expect(extracted.manifest).toEqual(created.manifest)
    expect(extracted.manifest.files.map((file) => [file.path, file.executable])).toEqual([
      ['SKILL.md', false],
      ['scripts/run.sh', process.platform !== 'win32']
    ])
    expect(await readFile(join(extracted.skillDirectory, 'scripts', 'run.sh'), 'utf8')).toContain(
      'echo test'
    )
    if (process.platform !== 'win32') {
      expect((await stat(created.archivePath)).mode & 0o777).toBe(0o600)
      expect((await stat(join(root, 'extracted'))).mode & 0o777).toBe(0o700)
      expect((await stat(extracted.skillDirectory)).mode & 0o777).toBe(0o700)
      expect((await stat(join(extracted.skillDirectory, 'SKILL.md'))).mode & 0o777).toBe(0o600)
      expect((await stat(join(extracted.skillDirectory, 'scripts', 'run.sh'))).mode & 0o777).toBe(
        0o700
      )
    }
  })

  it('creates deterministic archives for fixed publication metadata', async () => {
    const root = await temporaryDirectory()
    const sourceDirectory = await createSkill(root)
    const input = {
      sourceDirectory,
      packageId: 'package_1',
      versionId: 'version_1',
      createdAt: '2026-08-11T12:00:00.000Z'
    }
    const first = await createSkillPackageArchive({
      ...input,
      archivePath: join(root, 'one.tar.gz')
    })
    const second = await createSkillPackageArchive({
      ...input,
      archivePath: join(root, 'two.tar.gz')
    })

    expect(first.archiveSha256).toBe(second.archiveSha256)
    expect(await readFile(first.archivePath)).toEqual(await readFile(second.archivePath))
  })

  it('matches the cross-platform golden package identity', async () => {
    const root = await temporaryDirectory()
    const sourceDirectory = join(root, 'portable-skill')
    await mkdir(sourceDirectory)
    await writeFile(
      join(sourceDirectory, 'SKILL.md'),
      '---\nname: portable-skill\ndescription: Portable identity\n---\n\n# Portable\n'
    )
    await writeFile(join(sourceDirectory, 'notes.txt'), 'same bytes on every host\n')

    const created = await createSkillPackageArchive({
      sourceDirectory,
      archivePath: join(root, 'portable.tar.gz'),
      packageId: 'package_portable',
      versionId: 'version_portable',
      createdAt: '2026-08-11T12:00:00.000Z'
    })

    expect({
      archiveSha256: created.archiveSha256,
      packageDigest: created.manifest.packageDigest
    }).toEqual({
      archiveSha256: '20dbc3d2ba9f5e25c49551ebf2a5076b89594f9b67e03bc038aa9d974ac72894',
      packageDigest: '3bb1fc63cfea2f2b7f2cf80e539735eebd5bfb6aa65f47cf0db7e9fd35297f57'
    })
  })

  it('rejects archive and package identity mismatches before publishing extraction', async () => {
    const root = await temporaryDirectory()
    const sourceDirectory = await createSkill(root)
    const created = await createSkillPackageArchive({
      sourceDirectory,
      archivePath: join(root, 'package.tar.gz'),
      packageId: 'package_1',
      versionId: 'version_1'
    })

    await expect(
      extractSkillPackageArchive({
        archivePath: created.archivePath,
        destinationDirectory: join(root, 'wrong-package'),
        expectedPackageDigest: 'f'.repeat(64)
      })
    ).rejects.toThrow('skill-package-identity-mismatch')
    await expect(
      extractSkillPackageArchive({
        archivePath: created.archivePath,
        destinationDirectory: join(root, 'wrong-archive'),
        expectedArchiveSha256: 'f'.repeat(64)
      })
    ).rejects.toThrow('skill-package-archive-digest-mismatch')
  })

  it('rejects source changes after the package snapshot and removes temporary output', async () => {
    const root = await temporaryDirectory()
    const sourceDirectory = await createSkill(root)
    const archivePath = join(root, 'drifted.tar.gz')

    await expect(
      createSkillPackageArchive(
        {
          sourceDirectory,
          archivePath,
          packageId: 'package_1',
          versionId: 'version_1'
        },
        {
          afterSourceObserved: async () => {
            await writeFile(join(sourceDirectory, 'SKILL.md'), 'changed after observation')
          }
        }
      )
    ).rejects.toThrow('skill-package-source-changed-during-staging')
    await expect(readFile(archivePath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('normalizes LF and CRLF text identity while preserving exact archive bytes', async () => {
    const root = await temporaryDirectory()
    const lf = join(root, 'lf')
    const crlf = join(root, 'crlf')
    await Promise.all([mkdir(lf), mkdir(crlf)])
    const markdown = '---\nname: line-skill\ndescription: Lines\n---\n\n# Lines\n'
    await writeFile(join(lf, 'SKILL.md'), markdown)
    await writeFile(join(crlf, 'SKILL.md'), markdown.replaceAll('\n', '\r\n'))
    const publication = {
      packageId: 'package_1',
      versionId: 'version_1',
      createdAt: '2026-08-11T12:00:00.000Z'
    }

    const lfPackage = await createSkillPackageArchive({
      ...publication,
      sourceDirectory: lf,
      archivePath: join(root, 'lf.tar.gz')
    })
    const crlfPackage = await createSkillPackageArchive({
      ...publication,
      sourceDirectory: crlf,
      archivePath: join(root, 'crlf.tar.gz')
    })

    expect(lfPackage.manifest.packageDigest).toBe(crlfPackage.manifest.packageDigest)
    expect(lfPackage.manifest.files[0]?.identitySha256).toBe(
      crlfPackage.manifest.files[0]?.identitySha256
    )
    expect(lfPackage.manifest.files[0]?.sha256).not.toBe(crlfPackage.manifest.files[0]?.sha256)
    expect(lfPackage.archiveSha256).not.toBe(crlfPackage.archiveSha256)
  })

  it('rejects missing and malformed SKILL.md sources with stable archive errors', async () => {
    const root = await temporaryDirectory()
    const missing = join(root, 'missing')
    const malformed = join(root, 'malformed')
    await Promise.all([mkdir(missing), mkdir(malformed)])
    await writeFile(join(missing, 'README.md'), 'no skill')
    await writeFile(join(malformed, 'SKILL.md'), '# No frontmatter identity')
    const input = (sourceDirectory: string, name: string) => ({
      sourceDirectory,
      archivePath: join(root, `${name}.tar.gz`),
      packageId: 'package_1',
      versionId: 'version_1'
    })

    await expect(createSkillPackageArchive(input(missing, 'missing'))).rejects.toThrow(
      'skill-package-skill-markdown-required'
    )
    await expect(createSkillPackageArchive(input(malformed, 'malformed'))).rejects.toThrow(
      'skill-package-skill-name-invalid'
    )
  })

  it('rejects truncated tar data and invalid tar checksums before publishing extraction', async () => {
    const root = await temporaryDirectory()
    const created = await createSkillPackageArchive({
      sourceDirectory: await createSkill(root),
      archivePath: join(root, 'package.tar.gz'),
      packageId: 'package_1',
      versionId: 'version_1'
    })
    const invalidChecksum = join(root, 'invalid-checksum.tar.gz')
    const truncated = join(root, 'truncated.tar.gz')
    await mutateArchive(created.archivePath, invalidChecksum, (tar) => {
      tar[0] ^= 1
    })
    await mutateArchive(created.archivePath, truncated, (tar) => tar.subarray(0, -600))

    await expect(
      extractSkillPackageArchive({
        archivePath: invalidChecksum,
        destinationDirectory: join(root, 'invalid-checksum')
      })
    ).rejects.toThrow('skill-package-tar-checksum-invalid')
    await expect(
      extractSkillPackageArchive({
        archivePath: truncated,
        destinationDirectory: join(root, 'truncated')
      })
    ).rejects.toThrow('skill-package-tar-truncated')
  })

  it('maps invalid gzip bytes to a stable archive failure', async () => {
    const root = await temporaryDirectory()
    const archivePath = join(root, 'invalid-gzip.tar.gz')
    await writeFile(archivePath, 'not a gzip stream')

    await expect(
      extractSkillPackageArchive({
        archivePath,
        destinationDirectory: join(root, 'invalid-gzip')
      })
    ).rejects.toThrow('skill-package-gzip-invalid')
  })

  it('cancels during streamed extraction and removes partial bytes', async () => {
    const root = await temporaryDirectory()
    const created = await createSkillPackageArchive({
      sourceDirectory: await createSkill(root),
      archivePath: join(root, 'package.tar.gz'),
      packageId: 'package_1',
      versionId: 'version_1'
    })
    let checks = 0
    const signal = {
      get aborted() {
        checks += 1
        return checks >= 3
      }
    } as AbortSignal
    const destinationDirectory = join(root, 'cancelled-extraction')

    await expect(
      extractSkillPackageArchive({
        archivePath: created.archivePath,
        destinationDirectory,
        signal
      })
    ).rejects.toThrow('skill-install-cancelled')
    await expect(lstat(destinationDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects content checksum and SKILL identity mismatches', async () => {
    const root = await temporaryDirectory()
    const created = await createSkillPackageArchive({
      sourceDirectory: await createSkill(root),
      archivePath: join(root, 'package.tar.gz'),
      packageId: 'package_1',
      versionId: 'version_1'
    })
    const invalidContent = join(root, 'invalid-content.tar.gz')
    const invalidIdentity = join(root, 'invalid-identity.tar.gz')
    await mutateArchive(created.archivePath, invalidContent, (tar) => {
      const marker = Buffer.from('# Test\n')
      const offset = tar.indexOf(marker)
      expect(offset).toBeGreaterThan(0)
      tar[offset + 2] ^= 1
    })
    await mutateArchive(created.archivePath, invalidIdentity, (tar) => {
      const from = Buffer.from('"name":"test-skill"')
      const to = Buffer.from('"name":"best-skill"')
      const offset = tar.indexOf(from)
      expect(offset).toBeGreaterThan(0)
      to.copy(tar, offset)
    })

    await expect(
      extractSkillPackageArchive({
        archivePath: invalidContent,
        destinationDirectory: join(root, 'invalid-content')
      })
    ).rejects.toThrow('skill-package-file-digest-mismatch')
    await expect(
      extractSkillPackageArchive({
        archivePath: invalidIdentity,
        destinationDirectory: join(root, 'invalid-identity')
      })
    ).rejects.toThrow('skill-package-skill-name-mismatch')
  })
})
