import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  computeSkillPackageDigest,
  parseSkillPackageManifest,
  validateSkillPackageName,
  type SkillPackageManifestV1
} from '../../shared/skill-package-manifest'
import { summarizeSkillMarkdown } from '../../shared/skill-metadata'
import { renameSkillPathWithWindowsRetry } from './skill-filesystem-retry'
import { startSkillPhaseOperation } from './skill-operation-observability'
import { observeSkillPackage, type ObservedSkillPackage } from './skill-package-identity'
import { extractSkillPackageArchive } from './skill-package-extraction'
import { writeSkillTarGzip, type SkillTarWriteEntry } from './skill-package-tar'

export type CreatedSkillPackage = {
  manifest: SkillPackageManifestV1
  archivePath: string
  archiveSha256: string
  compressedBytes: number
}

export type SkillPackageCreationDependencies = {
  afterSourceObserved?: () => Promise<void>
}

function observationsMatch(left: ObservedSkillPackage, right: ObservedSkillPackage): boolean {
  return (
    left.files.length === right.files.length &&
    left.files.every((file, index) => {
      const other = right.files[index]
      return (
        file.path === other.path &&
        file.size === other.size &&
        file.executable === other.executable &&
        file.classification === other.classification &&
        file.exactSha256 === other.exactSha256 &&
        file.identitySha256 === other.identitySha256
      )
    })
  )
}

function packageManifest(input: {
  packageId: string
  versionId: string
  createdAt: string
  name: string
  description: string
  observed: ObservedSkillPackage
}): SkillPackageManifestV1 {
  const files = input.observed.files.map((file) => ({
    path: file.path,
    size: file.size,
    executable: file.executable,
    classification: file.classification,
    sha256: file.exactSha256,
    identitySha256: file.identitySha256
  }))
  return parseSkillPackageManifest({
    schemaVersion: 1,
    packageId: input.packageId,
    versionId: input.versionId,
    name: input.name,
    description: input.description,
    createdAt: input.createdAt,
    files,
    packageDigest: computeSkillPackageDigest(files)
  })
}

async function createSkillPackageArchiveUnobserved(
  input: {
    sourceDirectory: string
    archivePath: string
    packageId: string
    versionId: string
    createdAt?: string
  },
  dependencies: SkillPackageCreationDependencies = {}
): Promise<CreatedSkillPackage> {
  const sourceObservation = await observeSkillPackage(input.sourceDirectory)
  if (!sourceObservation.files.some((file) => file.path === 'SKILL.md')) {
    throw new Error('skill-package-skill-markdown-required')
  }
  await dependencies.afterSourceObserved?.()
  const workDirectory = await mkdtemp(join(tmpdir(), 'orca-skill-package-'))
  const stagedSkill = join(workDirectory, 'skill')
  const verificationDirectory = join(workDirectory, 'verification')
  const temporaryArchive = `${input.archivePath}.${process.pid}.${randomUUID()}.tmp`
  try {
    await cp(input.sourceDirectory, stagedSkill, {
      recursive: true,
      verbatimSymlinks: true,
      force: false,
      errorOnExist: true
    })
    const stagedObservation = await observeSkillPackage(stagedSkill)
    if (!observationsMatch(sourceObservation, stagedObservation)) {
      throw new Error('skill-package-source-changed-during-staging')
    }
    const summary = summarizeSkillMarkdown(await readFile(join(stagedSkill, 'SKILL.md'), 'utf8'))
    if (!summary.name) {
      throw new Error('skill-package-skill-name-required')
    }
    validateSkillPackageName(summary.name)
    const manifest = packageManifest({
      packageId: input.packageId,
      versionId: input.versionId,
      createdAt: input.createdAt ?? new Date().toISOString(),
      name: summary.name,
      description: summary.description ?? '',
      observed: stagedObservation
    })
    const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8')
    const entries: SkillTarWriteEntry[] = [
      {
        path: 'manifest.json',
        size: manifestBytes.length,
        executable: false,
        bytes: manifestBytes
      },
      ...manifest.files.map((file) => ({
        path: `skill/${file.path}`,
        size: file.size,
        executable: file.executable,
        sourcePath: join(stagedSkill, ...file.path.split('/'))
      }))
    ]
    await mkdir(dirname(input.archivePath), { recursive: true })
    const archiveIdentity = await writeSkillTarGzip(temporaryArchive, entries)
    await extractSkillPackageArchive({
      archivePath: temporaryArchive,
      destinationDirectory: verificationDirectory,
      expectedArchiveSha256: archiveIdentity.archiveSha256,
      expectedPackageDigest: manifest.packageDigest,
      expectedPackageId: manifest.packageId,
      expectedVersionId: manifest.versionId
    })
    await renameSkillPathWithWindowsRetry(temporaryArchive, input.archivePath)
    return { manifest, archivePath: input.archivePath, ...archiveIdentity }
  } finally {
    await rm(workDirectory, { recursive: true, force: true })
    await rm(temporaryArchive, { force: true }).catch(() => undefined)
  }
}

export async function createSkillPackageArchive(
  input: {
    sourceDirectory: string
    archivePath: string
    packageId: string
    versionId: string
    createdAt?: string
  },
  dependencies: SkillPackageCreationDependencies = {}
): Promise<CreatedSkillPackage> {
  const operation = startSkillPhaseOperation({
    phase: 'package',
    packageKind: 'single',
    skillCount: 1
  })
  try {
    const created = await createSkillPackageArchiveUnobserved(input, dependencies)
    operation.complete({
      status: 'complete',
      fileCount: created.manifest.files.length,
      totalBytes: created.manifest.files.reduce((total, file) => total + file.size, 0),
      compressedBytes: created.compressedBytes
    })
    return created
  } catch (error) {
    operation.fail(error)
    throw error
  }
}
