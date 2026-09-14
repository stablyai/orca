import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  AGENT_PLUGIN_MANIFEST_PATH,
  AGENT_PLUGIN_SCHEMA_V1,
  ORCA_SKILL_BUNDLE_MANIFEST_PATH,
  computeSkillBundleDigest,
  parseAgentPluginManifest,
  parseSkillBundleManifest,
  type AgentPluginManifestV1,
  type SkillBundleEntry,
  type SkillBundleManifestV1
} from '../../shared/skill-bundle-manifest'
import {
  computeSkillPackageDigest,
  validateSkillPackageName
} from '../../shared/skill-package-manifest'
import { summarizeSkillMarkdown } from '../../shared/skill-metadata'
import { renameSkillPathWithWindowsRetry } from './skill-filesystem-retry'
import { extractSkillBundleArchive } from './skill-bundle-extraction'
import {
  observedSkillPackagesMatch,
  observeSkillPackage,
  type ObservedSkillPackage
} from './skill-package-identity'
import { writeSkillTarGzip, type SkillTarWriteEntry } from './skill-package-tar'
import { startSkillPhaseOperation } from './skill-operation-observability'

export type SkillBundleSource = {
  id?: string
  sourceDirectory: string
  executablePaths?: ReadonlySet<string>
}

export type CreatedSkillBundle = {
  pluginManifest: AgentPluginManifestV1
  manifest: SkillBundleManifestV1
  archivePath: string
  archiveSha256: string
  compressedBytes: number
}

export type SkillBundleCreationDependencies = { afterSourcesObserved?: () => Promise<void> }

const SOURCE_OBSERVATION_CONCURRENCY = 4

function bundleEntry(input: {
  id: string
  name: string
  description: string
  observed: ObservedSkillPackage
}): SkillBundleEntry {
  const files = input.observed.files.map((file) => ({
    path: file.path,
    size: file.size,
    executable: file.executable,
    classification: file.classification,
    sha256: file.exactSha256,
    identitySha256: file.identitySha256
  }))
  return {
    id: input.id,
    name: input.name,
    description: input.description,
    digest: computeSkillPackageDigest(files),
    files
  }
}

async function stageSkill(input: {
  source: SkillBundleSource
  sourceObservation: ObservedSkillPackage
  skillsRoot: string
  name: string
  description: string
}): Promise<SkillBundleEntry> {
  const stagedDirectory = join(input.skillsRoot, input.name)
  await cp(input.source.sourceDirectory, stagedDirectory, {
    recursive: true,
    verbatimSymlinks: true,
    force: false,
    errorOnExist: true
  })
  const stagedObservation = await observeSkillPackage(
    stagedDirectory,
    undefined,
    input.source.executablePaths,
    undefined,
    process.platform,
    process.platform === 'win32'
  )
  if (!observedSkillPackagesMatch(input.sourceObservation, stagedObservation)) {
    throw new Error('skill-package-source-changed-during-staging')
  }
  const stagedSummary = summarizeSkillMarkdown(
    await readFile(join(stagedDirectory, 'SKILL.md'), 'utf8')
  )
  if (
    stagedSummary.name !== input.name ||
    (stagedSummary.description ?? '') !== input.description
  ) {
    throw new Error('skill-package-source-changed-during-staging')
  }
  return bundleEntry({
    id: input.source.id ?? input.name,
    name: input.name,
    description: input.description,
    observed: stagedObservation
  })
}

async function createSkillBundleArchiveUnobserved(
  input: {
    sources: readonly SkillBundleSource[]
    archivePath: string
    packageId: string
    versionId: string
    bundleName: string
    description?: string
    createdAt?: string
  },
  dependencies: SkillBundleCreationDependencies = {}
): Promise<CreatedSkillBundle> {
  if (input.sources.length === 0) {
    throw new Error('skill-bundle-empty')
  }
  const sourceObservations: ObservedSkillPackage[] = []
  const summaries: { name: string; description: string }[] = []
  for (let offset = 0; offset < input.sources.length; offset += SOURCE_OBSERVATION_CONCURRENCY) {
    const batch = input.sources.slice(offset, offset + SOURCE_OBSERVATION_CONCURRENCY)
    const observed = await Promise.all(
      batch.map(async (source) => {
        const [observation, markdown] = await Promise.all([
          observeSkillPackage(
            source.sourceDirectory,
            undefined,
            source.executablePaths,
            undefined,
            process.platform,
            process.platform === 'win32'
          ),
          readFile(join(source.sourceDirectory, 'SKILL.md'), 'utf8')
        ])
        const summary = summarizeSkillMarkdown(markdown)
        if (!summary.name) {
          throw new Error('skill-package-skill-name-required')
        }
        validateSkillPackageName(summary.name)
        return {
          observation,
          summary: { name: summary.name, description: summary.description ?? '' }
        }
      })
    )
    sourceObservations.push(...observed.map((value) => value.observation))
    summaries.push(...observed.map((value) => value.summary))
  }
  const foldedNames = new Set<string>()
  for (const summary of summaries) {
    const foldedName = summary.name.toLocaleLowerCase('en-US')
    if (foldedNames.has(foldedName)) {
      throw new Error('skill-bundle-skill-collision')
    }
    foldedNames.add(foldedName)
  }
  await dependencies.afterSourcesObserved?.()
  const workDirectory = await mkdtemp(join(tmpdir(), 'orca-skill-bundle-'))
  const skillsRoot = join(workDirectory, 'skills')
  const verificationDirectory = join(workDirectory, 'verification')
  const temporaryArchive = `${input.archivePath}.${process.pid}.${randomUUID()}.tmp`
  try {
    await mkdir(skillsRoot, { recursive: true })
    const skills: SkillBundleEntry[] = []
    for (const [index, source] of input.sources.entries()) {
      const skill = await stageSkill({
        source,
        sourceObservation: sourceObservations[index],
        skillsRoot,
        ...summaries[index]
      })
      skills.push(skill)
    }
    skills.sort((left, right) => left.name.localeCompare(right.name, 'en-US'))
    const manifest = parseSkillBundleManifest({
      schemaVersion: 1,
      packageId: input.packageId,
      versionId: input.versionId,
      bundleName: input.bundleName,
      description: input.description ?? '',
      createdAt: input.createdAt ?? new Date().toISOString(),
      skills,
      bundleDigest: computeSkillBundleDigest(skills)
    })
    const pluginManifest = parseAgentPluginManifest({
      $schema: AGENT_PLUGIN_SCHEMA_V1,
      name: manifest.bundleName,
      version: manifest.versionId,
      description: manifest.description
    })
    const pluginBytes = Buffer.from(JSON.stringify(pluginManifest), 'utf8')
    const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8')
    const entries: SkillTarWriteEntry[] = [
      {
        path: AGENT_PLUGIN_MANIFEST_PATH,
        size: pluginBytes.length,
        executable: false,
        bytes: pluginBytes
      },
      {
        path: ORCA_SKILL_BUNDLE_MANIFEST_PATH,
        size: manifestBytes.length,
        executable: false,
        bytes: manifestBytes
      },
      ...manifest.skills.flatMap((skill) =>
        skill.files.map((file) => ({
          path: `skills/${skill.name}/${file.path}`,
          size: file.size,
          executable: file.executable,
          sourcePath: join(skillsRoot, skill.name, ...file.path.split('/'))
        }))
      )
    ]
    await mkdir(dirname(input.archivePath), { recursive: true })
    const archiveIdentity = await writeSkillTarGzip(temporaryArchive, entries)
    await extractSkillBundleArchive({
      archivePath: temporaryArchive,
      destinationDirectory: verificationDirectory,
      expectedArchiveSha256: archiveIdentity.archiveSha256,
      expectedBundleDigest: manifest.bundleDigest,
      expectedPackageId: manifest.packageId,
      expectedVersionId: manifest.versionId
    })
    await renameSkillPathWithWindowsRetry(temporaryArchive, input.archivePath)
    return { pluginManifest, manifest, archivePath: input.archivePath, ...archiveIdentity }
  } finally {
    await rm(workDirectory, { recursive: true, force: true })
    await rm(temporaryArchive, { force: true }).catch(() => undefined)
  }
}

export async function createSkillBundleArchive(
  input: {
    sources: readonly SkillBundleSource[]
    archivePath: string
    packageId: string
    versionId: string
    bundleName: string
    description?: string
    createdAt?: string
  },
  dependencies: SkillBundleCreationDependencies = {}
): Promise<CreatedSkillBundle> {
  const operation = startSkillPhaseOperation({
    phase: 'package',
    packageKind: 'bundle',
    skillCount: input.sources.length
  })
  try {
    const created = await createSkillBundleArchiveUnobserved(input, dependencies)
    const files = created.manifest.skills.flatMap((skill) => skill.files)
    operation.complete({
      status: 'complete',
      fileCount: files.length,
      totalBytes: files.reduce((total, file) => total + file.size, 0),
      compressedBytes: created.compressedBytes
    })
    return created
  } catch (error) {
    operation.fail(error)
    throw error
  }
}
