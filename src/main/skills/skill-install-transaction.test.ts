import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createSkillPackageArchive } from './skill-package-creation'
import {
  installLocalSkillPackage,
  previewLocalSkillPackage,
  type LocalSkillInstallInput
} from './skill-install-transaction'
import { nativeSkillInstallFilesystem } from './skill-install-filesystem'
import { acquireSkillInstallLock } from './skill-install-lock'
import { skillInstallStateKey } from './skill-install-provenance'

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'orca-skill-install-test-'))
  temporaryDirectories.push(directory)
  return directory
}

async function packageVersion(root: string, version: string, body: string) {
  const source = join(root, `source-${version}`)
  await mkdir(source, { recursive: true })
  await writeFile(
    join(source, 'SKILL.md'),
    `---\nname: test-skill\ndescription: Test skill\n---\n\n${body}\n`
  )
  return createSkillPackageArchive({
    sourceDirectory: source,
    archivePath: join(root, `${version}.tar.gz`),
    packageId: 'package_1',
    versionId: version,
    createdAt: '2026-08-11T12:00:00.000Z'
  })
}

function installInput(
  root: string,
  archive: Awaited<ReturnType<typeof packageVersion>>,
  overrides: Partial<LocalSkillInstallInput> = {}
): LocalSkillInstallInput {
  return {
    operationId: `operation-${archive.manifest.versionId}`,
    archivePath: archive.archivePath,
    destinationRoot: join(root, 'skills'),
    stateDirectory: join(root, 'state'),
    scope: 'global',
    destinationIdentity: 'global:test-host',
    hostIdentity: 'test-host',
    expectedArchiveSha256: archive.archiveSha256,
    expectedPackageDigest: archive.manifest.packageDigest,
    expectedPackageId: archive.manifest.packageId,
    expectedVersionId: archive.manifest.versionId,
    ...overrides
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true }))
  )
})

describe('skill install transaction', () => {
  it('installs, previews unchanged bytes, and updates a clean receipt-owned skill', async () => {
    const root = await temporaryDirectory()
    const first = await packageVersion(root, 'version_1', '# First')
    const second = await packageVersion(root, 'version_2', '# Second')

    const installed = await installLocalSkillPackage(installInput(root, first))
    expect(installed.status).toBe('installed')
    expect(await readFile(join(root, 'skills', 'test-skill', 'SKILL.md'), 'utf8')).toContain(
      '# First'
    )

    const preview = await previewLocalSkillPackage(installInput(root, first))
    expect(preview.currentState.kind).toBe('unchanged')
    expect((await installLocalSkillPackage(installInput(root, first))).status).toBe('unchanged')

    const updated = await installLocalSkillPackage(installInput(root, second))
    expect(updated.status).toBe('updated')
    expect(await readFile(join(root, 'skills', 'test-skill', 'SKILL.md'), 'utf8')).toContain(
      '# Second'
    )
  })

  it('refuses to overwrite a modified receipt-owned installation', async () => {
    const root = await temporaryDirectory()
    const first = await packageVersion(root, 'version_1', '# First')
    const second = await packageVersion(root, 'version_2', '# Second')
    await installLocalSkillPackage(installInput(root, first))
    await writeFile(join(root, 'skills', 'test-skill', 'local.md'), 'local change')

    const result = await installLocalSkillPackage(installInput(root, second))

    expect(result.status).toBe('conflict')
    expect(result.conflict?.kind).toBe('modified')
    expect(await readFile(join(root, 'skills', 'test-skill', 'local.md'), 'utf8')).toBe(
      'local change'
    )
  })

  it('requires explicit replacement for an unowned directory', async () => {
    const root = await temporaryDirectory()
    const archive = await packageVersion(root, 'version_1', '# Cloud')
    const destination = join(root, 'skills', 'test-skill')
    await mkdir(destination, { recursive: true })
    await writeFile(join(destination, 'SKILL.md'), 'unowned')

    const conflict = await installLocalSkillPackage(installInput(root, archive))
    expect(conflict.conflict?.kind).toBe('unowned')

    const replaced = await installLocalSkillPackage(
      installInput(root, archive, { conflictResolution: 'replace-and-discard-local' })
    )
    expect(replaced.status).toBe('installed')
    expect(await readFile(join(destination, 'SKILL.md'), 'utf8')).toContain('# Cloud')
  })

  it('preserves a regular file at the canonical destination as a name collision', async () => {
    const root = await temporaryDirectory()
    const archive = await packageVersion(root, 'version_1', '# Cloud')
    const destination = join(root, 'skills', 'test-skill')
    await mkdir(join(root, 'skills'), { recursive: true })
    await writeFile(destination, 'unowned regular file')

    const result = await installLocalSkillPackage(installInput(root, archive))

    expect(result).toMatchObject({ status: 'conflict', conflict: { kind: 'name-collision' } })
    expect(await readFile(destination, 'utf8')).toBe('unowned regular file')
  })

  it('rejects a case-insensitive sibling collision before destination mutation', async () => {
    const root = await temporaryDirectory()
    const archive = await packageVersion(root, 'version_1', '# Cloud')
    const collision = join(root, 'skills', 'TEST-SKILL')
    await mkdir(collision, { recursive: true })
    await writeFile(join(collision, 'SKILL.md'), 'existing case variant')

    const result = await installLocalSkillPackage(installInput(root, archive))

    expect(result).toMatchObject({ status: 'conflict', conflict: { kind: 'name-collision' } })
    expect(await readFile(join(collision, 'SKILL.md'), 'utf8')).toBe('existing case variant')
  })

  it.runIf(process.platform === 'win32')(
    'installs through a canonical Windows path longer than MAX_PATH',
    async () => {
      const root = await temporaryDirectory()
      const archive = await packageVersion(root, 'version_1', '# Long path')
      const destinationRoot = join(
        root,
        ...Array.from({ length: 6 }, (_, index) => `segment-${index}-${'x'.repeat(32)}`),
        'skills'
      )
      await mkdir(destinationRoot, { recursive: true })
      const canonicalPath = join(destinationRoot, 'test-skill')
      expect(canonicalPath.length).toBeGreaterThan(260)

      const result = await installLocalSkillPackage(
        installInput(root, archive, { destinationRoot })
      )

      expect(result.status).toBe('installed')
      expect(await readFile(join(canonicalPath, 'SKILL.md'), 'utf8')).toContain('# Long path')
    }
  )

  it('restores the previous version when commit is interrupted after backup', async () => {
    const root = await temporaryDirectory()
    const first = await packageVersion(root, 'version_1', '# First')
    const second = await packageVersion(root, 'version_2', '# Second')
    await installLocalSkillPackage(installInput(root, first))
    let renameCount = 0
    const interruptedFilesystem = {
      ...nativeSkillInstallFilesystem,
      rename: async (source: string, target: string): Promise<void> => {
        renameCount += 1
        if (renameCount === 3) {
          throw new Error('injected-commit-interruption')
        }
        await nativeSkillInstallFilesystem.rename(source, target)
      }
    }

    await expect(
      installLocalSkillPackage(installInput(root, second, { filesystem: interruptedFilesystem }))
    ).rejects.toThrow('injected-commit-interruption')
    expect(await readFile(join(root, 'skills', 'test-skill', 'SKILL.md'), 'utf8')).toContain(
      '# First'
    )

    const retried = await installLocalSkillPackage(installInput(root, second))
    expect(retried.status).toBe('updated')
    expect(await readFile(join(root, 'skills', 'test-skill', 'SKILL.md'), 'utf8')).toContain(
      '# Second'
    )
  })

  it('returns a retryable result after rename exhaustion preserves the old version', async () => {
    const root = await temporaryDirectory()
    const first = await packageVersion(root, 'version_1', '# First')
    const second = await packageVersion(root, 'version_2', '# Second')
    await installLocalSkillPackage(installInput(root, first))
    const busyFilesystem = {
      ...nativeSkillInstallFilesystem,
      rename: async (source: string, target: string): Promise<void> => {
        if (target.includes('.orca-backup-')) {
          throw Object.assign(new Error('locked by scanner'), { code: 'EBUSY' })
        }
        await nativeSkillInstallFilesystem.rename(source, target)
      }
    }

    const result = await installLocalSkillPackage(
      installInput(root, second, { filesystem: busyFilesystem })
    )

    expect(result).toMatchObject({
      status: 'failed',
      errorCategory: 'skill-install-filesystem-failed',
      failure: { category: 'filesystem', retryable: true }
    })
    expect(await readFile(join(root, 'skills', 'test-skill', 'SKILL.md'), 'utf8')).toContain(
      '# First'
    )
  })

  it.each([
    ['EACCES', true],
    ['ENOSPC', false]
  ] as const)(
    'preserves the old version after a %s filesystem failure',
    async (code, retryable) => {
      const root = await temporaryDirectory()
      const first = await packageVersion(root, 'version_1', '# First')
      const second = await packageVersion(root, 'version_2', '# Second')
      await installLocalSkillPackage(installInput(root, first))
      const failingFilesystem = {
        ...nativeSkillInstallFilesystem,
        rename: async (source: string, target: string): Promise<void> => {
          if (target.includes('.orca-backup-')) {
            throw Object.assign(new Error(`injected ${code}`), { code })
          }
          await nativeSkillInstallFilesystem.rename(source, target)
        }
      }

      const result = await installLocalSkillPackage(
        installInput(root, second, { filesystem: failingFilesystem })
      )

      expect(result).toMatchObject({
        status: 'failed',
        failure: { category: 'filesystem', retryable }
      })
      expect(await readFile(join(root, 'skills', 'test-skill', 'SKILL.md'), 'utf8')).toContain(
        '# First'
      )
    }
  )

  it('returns a retryable failure when another process owns the destination lock', async () => {
    const root = await temporaryDirectory()
    const archive = await packageVersion(root, 'version_1', '# First')
    const canonicalPath = join(root, 'skills', 'test-skill')
    const lockPath = join(root, 'state', 'locks', `${skillInstallStateKey(canonicalPath)}.lock`)
    const release = await acquireSkillInstallLock({ path: lockPath })
    try {
      const result = await installLocalSkillPackage(
        installInput(root, archive, { lockTimeoutMs: 1 })
      )
      expect(result).toMatchObject({
        status: 'failed',
        errorCategory: 'skill-install-busy',
        failure: { category: 'filesystem', retryable: true }
      })
      expect(
        (await readdir(join(root, 'skills'))).filter((name) => name.includes('extract'))
      ).toEqual([])
    } finally {
      await release()
    }
  })

  it('serializes simultaneous installs without duplicate provenance or staging bytes', async () => {
    const root = await temporaryDirectory()
    const archive = await packageVersion(root, 'version_1', '# Concurrent')

    const results = await Promise.all([
      installLocalSkillPackage(installInput(root, archive, { operationId: 'concurrent-a' })),
      installLocalSkillPackage(installInput(root, archive, { operationId: 'concurrent-b' }))
    ])

    expect(results.map((result) => result.status).sort()).toEqual(['installed', 'unchanged'])
    expect(await readFile(join(root, 'skills', 'test-skill', 'SKILL.md'), 'utf8')).toContain(
      '# Concurrent'
    )
    expect((await readdir(join(root, 'skills'))).filter((name) => name.includes('.orca-'))).toEqual(
      []
    )
    expect(await readdir(join(root, 'state', 'receipts'))).toHaveLength(1)
  })

  it('invalidates a plan when destination state changes immediately before commit', async () => {
    const root = await temporaryDirectory()
    const archive = await packageVersion(root, 'version_1', '# Cloud')
    const canonicalPath = join(root, 'skills', 'test-skill')
    let injected = false
    const changingFilesystem = {
      ...nativeSkillInstallFilesystem,
      rename: async (source: string, target: string): Promise<void> => {
        await nativeSkillInstallFilesystem.rename(source, target)
        if (!injected && target.includes('.orca-staging-')) {
          injected = true
          await mkdir(canonicalPath)
          await writeFile(join(canonicalPath, 'SKILL.md'), 'local content')
        }
      }
    }

    const result = await installLocalSkillPackage(
      installInput(root, archive, { filesystem: changingFilesystem })
    )

    expect(result).toMatchObject({
      status: 'conflict',
      errorCategory: 'skill-install-conflict-stale-preview'
    })
    expect(await readFile(join(canonicalPath, 'SKILL.md'), 'utf8')).toBe('local content')
    expect((await readdir(join(root, 'skills'))).filter((name) => name.includes('.orca-'))).toEqual(
      []
    )
  })

  it('restores the old version when cancellation arrives before canonical placement', async () => {
    const root = await temporaryDirectory()
    const first = await packageVersion(root, 'version_1', '# First')
    const second = await packageVersion(root, 'version_2', '# Second')
    await installLocalSkillPackage(installInput(root, first))
    const controller = new AbortController()
    const cancellingFilesystem = {
      ...nativeSkillInstallFilesystem,
      rename: async (source: string, target: string): Promise<void> => {
        await nativeSkillInstallFilesystem.rename(source, target)
        if (target.includes('.orca-backup-')) {
          controller.abort()
        }
      }
    }

    const result = await installLocalSkillPackage(
      installInput(root, second, { filesystem: cancellingFilesystem, signal: controller.signal })
    )

    expect(result).toMatchObject({
      status: 'cancelled',
      failure: { category: 'cancelled', retryable: true }
    })
    expect(await readFile(join(root, 'skills', 'test-skill', 'SKILL.md'), 'utf8')).toContain(
      '# First'
    )
    await expect(lstat(join(root, 'state', 'journals'))).resolves.toBeDefined()
    expect(await readdir(join(root, 'state', 'journals'))).toEqual([])
  })

  it('removes staging bytes when cancellation arrives after the staging move', async () => {
    const root = await temporaryDirectory()
    const archive = await packageVersion(root, 'version_1', '# First')
    const controller = new AbortController()
    const cancellingFilesystem = {
      ...nativeSkillInstallFilesystem,
      rename: async (source: string, target: string): Promise<void> => {
        await nativeSkillInstallFilesystem.rename(source, target)
        if (target.includes('.orca-staging-')) {
          controller.abort()
        }
      }
    }

    const result = await installLocalSkillPackage(
      installInput(root, archive, { filesystem: cancellingFilesystem, signal: controller.signal })
    )

    expect(result).toMatchObject({
      status: 'cancelled',
      failure: { category: 'cancelled', retryable: true }
    })
    await expect(lstat(join(root, 'skills', 'test-skill'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
    expect((await readdir(join(root, 'skills'))).filter((name) => name.includes('.orca-'))).toEqual(
      []
    )
  })

  it('finishes provenance safely when cancellation arrives after canonical commit', async () => {
    const root = await temporaryDirectory()
    const archive = await packageVersion(root, 'version_1', '# First')
    const controller = new AbortController()

    const result = await installLocalSkillPackage(
      installInput(root, archive, { signal: controller.signal }),
      {
        onJournalTransition: async (phase, boundary) => {
          if (phase === 'receipt-published' && boundary === 'before') {
            controller.abort()
          }
        }
      }
    )

    expect(result.status).toBe('installed')
    expect(await readFile(join(root, 'skills', 'test-skill', 'SKILL.md'), 'utf8')).toContain(
      '# First'
    )
    await expect(
      readFile(
        join(
          root,
          'state',
          'receipts',
          `${skillInstallStateKey(join(root, 'skills', 'test-skill'))}.json`
        ),
        'utf8'
      )
    ).resolves.toContain('version_1')
  })

  it.each(
    ['prepared', 'backup-created', 'canonical-placed', 'receipt-published', 'complete'].flatMap(
      (phase) => ['before', 'after'].map((boundary) => [phase, boundary] as const)
    )
  )('recovers failure %s the %s journal transition', async (phase, boundary) => {
    const root = await temporaryDirectory()
    const first = await packageVersion(root, 'version_1', '# First')
    const second = await packageVersion(root, 'version_2', '# Second')
    await installLocalSkillPackage(installInput(root, first))

    await expect(
      installLocalSkillPackage(installInput(root, second), {
        onJournalTransition: async (currentPhase, currentBoundary) => {
          if (currentPhase === phase && currentBoundary === boundary) {
            throw new Error(`injected-${phase}-${boundary}`)
          }
        }
      })
    ).rejects.toThrow(`injected-${phase}-${boundary}`)

    const skillMarkdown = await readFile(join(root, 'skills', 'test-skill', 'SKILL.md'), 'utf8')
    expect(skillMarkdown.includes('# First') || skillMarkdown.includes('# Second')).toBe(true)
    expect((await readdir(join(root, 'skills'))).filter((name) => name.includes('.orca-'))).toEqual(
      []
    )
    expect(await readdir(join(root, 'state', 'journals'))).toEqual([])
    await expect(installLocalSkillPackage(installInput(root, second))).resolves.toMatchObject({
      status: expect.stringMatching(/^(updated|unchanged)$/)
    })
  })
})
