import { createHash } from 'node:crypto'
import { mkdir, open, readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  AGENT_PLUGIN_MANIFEST_PATH,
  ORCA_SKILL_BUNDLE_MANIFEST_PATH,
  parseAgentPluginManifest,
  parseSkillBundleManifest,
  type AgentPluginManifestV1,
  type SkillBundleManifestV1
} from '../../shared/skill-bundle-manifest'
import {
  SKILL_PACKAGE_MAX_MANIFEST_BYTES,
  type SkillPackageFile
} from '../../shared/skill-package-manifest'
import { SKILL_INSTALL_CANCELLED_FAILURE } from '../../shared/skill-install-failure'
import { summarizeSkillMarkdown } from '../../shared/skill-metadata'
import { observeSkillPackage } from './skill-package-identity'
import {
  openSkillTarGzip,
  parseSkillTarHeader,
  SKILL_TAR_BLOCK_BYTES,
  type TarByteReader
} from './skill-package-tar'
import { SkillInstallOperationError } from './skill-install-operation-error'

export type SkillBundleExtractionResult = {
  pluginManifest: AgentPluginManifestV1
  manifest: SkillBundleManifestV1
  skillsDirectory: string
  archiveSha256: string
  compressedBytes: number
}

const SKILL_VERIFICATION_CONCURRENCY = 4

async function consumePadding(reader: TarByteReader, size: number): Promise<void> {
  const padding = (SKILL_TAR_BLOCK_BYTES - (size % SKILL_TAR_BLOCK_BYTES)) % SKILL_TAR_BLOCK_BYTES
  if (padding > 0 && !(await reader.readExact(padding)).every((byte) => byte === 0)) {
    throw new Error('skill-package-tar-padding-invalid')
  }
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new SkillInstallOperationError(SKILL_INSTALL_CANCELLED_FAILURE)
  }
}

async function readJsonEntry(
  reader: TarByteReader,
  expectedPath: string,
  signal?: AbortSignal
): Promise<unknown> {
  throwIfCancelled(signal)
  const header = parseSkillTarHeader(await reader.readExact(SKILL_TAR_BLOCK_BYTES))
  if (
    !header ||
    header.path !== expectedPath ||
    header.executable ||
    header.size > SKILL_PACKAGE_MAX_MANIFEST_BYTES
  ) {
    throw new Error('skill-bundle-manifest-envelope-invalid')
  }
  const bytes = await reader.readExact(header.size)
  throwIfCancelled(signal)
  await consumePadding(reader, header.size)
  try {
    return JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new Error('skill-bundle-manifest-invalid')
  }
}

async function extractFile(
  reader: TarByteReader,
  destination: string,
  expected: SkillPackageFile,
  signal?: AbortSignal
): Promise<void> {
  throwIfCancelled(signal)
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  const handle = await open(destination, 'wx', expected.executable ? 0o700 : 0o600)
  const hash = createHash('sha256')
  let offset = 0
  try {
    while (offset < expected.size) {
      throwIfCancelled(signal)
      const bytes = await reader.readExact(Math.min(64 * 1024, expected.size - offset))
      hash.update(bytes)
      let written = 0
      while (written < bytes.length) {
        const result = await handle.write(bytes, written, bytes.length - written, offset + written)
        if (result.bytesWritten === 0) {
          throw new Error('skill-package-extraction-write-failed')
        }
        written += result.bytesWritten
      }
      offset += bytes.length
    }
  } finally {
    await handle.close()
  }
  if (hash.digest('hex') !== expected.sha256) {
    throw new Error('skill-package-file-digest-mismatch')
  }
  await consumePadding(reader, expected.size)
}

async function requireArchiveEnd(reader: TarByteReader, signal?: AbortSignal): Promise<void> {
  for (let index = 0; index < 2; index += 1) {
    throwIfCancelled(signal)
    if (!(await reader.readExact(SKILL_TAR_BLOCK_BYTES)).every((byte) => byte === 0)) {
      throw new Error('skill-package-tar-trailing-entry')
    }
  }
  for (;;) {
    throwIfCancelled(signal)
    const block = await reader.readExactOrNull(SKILL_TAR_BLOCK_BYTES)
    if (!block) {
      return
    }
    if (!block.every((byte) => byte === 0)) {
      throw new Error('skill-package-tar-trailing-data')
    }
  }
}

async function verifySkill(input: {
  directory: string
  manifest: SkillBundleManifestV1['skills'][number]
  signal?: AbortSignal
  platform: NodeJS.Platform
}): Promise<void> {
  throwIfCancelled(input.signal)
  const executablePaths =
    input.platform === 'win32'
      ? new Set(input.manifest.files.filter((file) => file.executable).map((file) => file.path))
      : undefined
  const observed = await observeSkillPackage(
    input.directory,
    undefined,
    executablePaths,
    input.signal,
    input.platform
  )
  throwIfCancelled(input.signal)
  if (
    observed.observedDigest !== input.manifest.digest ||
    observed.files.length !== input.manifest.files.length ||
    observed.files.some((file, index) => {
      const expected = input.manifest.files[index]
      return (
        file.path !== expected.path ||
        file.exactSha256 !== expected.sha256 ||
        file.identitySha256 !== expected.identitySha256 ||
        file.executable !== expected.executable
      )
    })
  ) {
    throw new Error('skill-bundle-extracted-identity-mismatch')
  }
  const summary = summarizeSkillMarkdown(await readFile(join(input.directory, 'SKILL.md'), 'utf8'))
  if (summary.name !== input.manifest.name) {
    throw new Error('skill-package-skill-name-mismatch')
  }
}

export async function extractSkillBundleArchive(input: {
  archivePath: string
  destinationDirectory: string
  expectedArchiveSha256?: string
  expectedBundleDigest?: string
  expectedPackageId?: string
  expectedVersionId?: string
  signal?: AbortSignal
  platform?: NodeJS.Platform
}): Promise<SkillBundleExtractionResult> {
  const archive = await openSkillTarGzip(input.archivePath)
  let destinationCreated = false
  try {
    throwIfCancelled(input.signal)
    await mkdir(input.destinationDirectory, { mode: 0o700 })
    destinationCreated = true
    const pluginManifest = parseAgentPluginManifest(
      await readJsonEntry(archive.reader, AGENT_PLUGIN_MANIFEST_PATH, input.signal)
    )
    const manifest = parseSkillBundleManifest(
      await readJsonEntry(archive.reader, ORCA_SKILL_BUNDLE_MANIFEST_PATH, input.signal)
    )
    if (
      pluginManifest.name !== manifest.bundleName ||
      pluginManifest.version !== manifest.versionId ||
      (input.expectedBundleDigest && input.expectedBundleDigest !== manifest.bundleDigest) ||
      (input.expectedPackageId && input.expectedPackageId !== manifest.packageId) ||
      (input.expectedVersionId && input.expectedVersionId !== manifest.versionId)
    ) {
      throw new Error('skill-bundle-identity-mismatch')
    }
    const skillsDirectory = join(input.destinationDirectory, 'skills')
    await mkdir(skillsDirectory, { mode: 0o700 })
    for (const skill of manifest.skills) {
      for (const file of skill.files) {
        throwIfCancelled(input.signal)
        const archivePath = `skills/${skill.name}/${file.path}`
        const header = parseSkillTarHeader(await archive.reader.readExact(SKILL_TAR_BLOCK_BYTES))
        if (
          !header ||
          header.path !== archivePath ||
          header.size !== file.size ||
          header.executable !== file.executable
        ) {
          throw new Error('skill-bundle-file-envelope-mismatch')
        }
        await extractFile(
          archive.reader,
          join(skillsDirectory, skill.name, ...file.path.split('/')),
          file,
          input.signal
        )
      }
    }
    await requireArchiveEnd(archive.reader, input.signal)
    const archiveIdentity = await archive.archiveIdentity
    if (
      input.expectedArchiveSha256 &&
      archiveIdentity.archiveSha256 !== input.expectedArchiveSha256
    ) {
      throw new Error('skill-package-archive-digest-mismatch')
    }
    for (
      let offset = 0;
      offset < manifest.skills.length;
      offset += SKILL_VERIFICATION_CONCURRENCY
    ) {
      const batch = manifest.skills.slice(offset, offset + SKILL_VERIFICATION_CONCURRENCY)
      await Promise.all(
        batch.map((skill) =>
          verifySkill({
            directory: join(skillsDirectory, skill.name),
            manifest: skill,
            signal: input.signal,
            platform: input.platform ?? process.platform
          })
        )
      )
    }
    throwIfCancelled(input.signal)
    return { pluginManifest, manifest, skillsDirectory, ...archiveIdentity }
  } catch (error) {
    const failure = input.signal?.aborted
      ? new SkillInstallOperationError(SKILL_INSTALL_CANCELLED_FAILURE, { cause: error })
      : error instanceof Error
        ? error
        : new Error(String(error))
    archive.abort(failure)
    await archive.archiveIdentity.catch(() => undefined)
    if (destinationCreated) {
      await rm(input.destinationDirectory, { recursive: true, force: true })
    }
    throw failure
  }
}
