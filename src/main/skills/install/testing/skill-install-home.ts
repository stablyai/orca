import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSkillPackageArchive } from '../../package-archive/skill-package-creation'
import type { SkillInstallServiceInput } from '../skill-installation'

const temporaryDirectories: string[] = []

export async function createSkillInstallHome(): Promise<{
  root: string
  input: SkillInstallServiceInput
}> {
  const root = await mkdtemp(join(tmpdir(), 'orca-skill-service-test-'))
  temporaryDirectories.push(root)
  const source = join(root, 'source')
  await mkdir(source)
  await writeFile(
    join(source, 'SKILL.md'),
    '---\nname: test-skill\ndescription: Test\n---\n\n# Test\n'
  )
  const archive = await createSkillPackageArchive({
    sourceDirectory: source,
    archivePath: join(root, 'package.tar.gz'),
    packageId: 'package_1',
    versionId: 'version_1'
  })
  return {
    root,
    input: {
      operationId: 'operation_1',
      archivePath: archive.archivePath,
      scope: 'global',
      homeDirectory: join(root, 'home'),
      orcaStateDirectory: join(root, 'orca-state'),
      detectedProviders: ['codex', 'claude'],
      destinationIdentity: 'global:test-host',
      hostIdentity: 'test-host',
      expectedArchiveSha256: archive.archiveSha256,
      expectedPackageDigest: archive.manifest.packageDigest,
      expectedPackageId: archive.manifest.packageId,
      expectedVersionId: archive.manifest.versionId
    }
  }
}

export async function removeSkillInstallHomes(): Promise<void> {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true }))
  )
}
