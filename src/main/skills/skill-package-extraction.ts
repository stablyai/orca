import { createHash } from 'node:crypto'
import { mkdir, open, readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  SKILL_PACKAGE_MAX_MANIFEST_BYTES,
  parseSkillPackageManifest,
  type SkillPackageFile,
  type SkillPackageManifestV1
} from '../../shared/skill-package-manifest'
import { summarizeSkillMarkdown } from '../../shared/skill-metadata'
import type { ObservedSkillPackage } from './skill-package-identity'
import {
  openSkillTarGzip,
  parseSkillTarHeader,
  SKILL_TAR_BLOCK_BYTES,
  type TarByteReader
} from './skill-package-tar'
import {
  nativeSkillInstallFilesystem,
  type SkillInstallFilesystem
} from './skill-install-filesystem'
import { SKILL_INSTALL_CANCELLED_FAILURE } from '../../shared/skill-install-failure'
import { SkillInstallOperationError } from './skill-install-operation-error'

export type SkillPackageExtractionResult = {
  manifest: SkillPackageManifestV1
  skillDirectory: string
  archiveSha256: string
  compressedBytes: number
}

function normalizeArchiveReadError(error: unknown): Error {
  if (!(error instanceof Error)) {
    return new Error(String(error))
  }
  const code = (error as NodeJS.ErrnoException).code
  if (code?.startsWith('Z_') || code?.startsWith('ERR_ZLIB_')) {
    return new Error('skill-package-gzip-invalid', { cause: error })
  }
  return error
}

async function consumeZeroPadding(reader: TarByteReader, size: number): Promise<void> {
  const padding = (SKILL_TAR_BLOCK_BYTES - (size % SKILL_TAR_BLOCK_BYTES)) % SKILL_TAR_BLOCK_BYTES
  if (padding === 0) {
    return
  }
  if (!(await reader.readExact(padding)).every((byte) => byte === 0)) {
    throw new Error('skill-package-tar-padding-invalid')
  }
}

async function extractFile(
  reader: TarByteReader,
  destination: string,
  expected: SkillPackageFile,
  signal?: AbortSignal
): Promise<void> {
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  const handle = await open(destination, 'wx', expected.executable ? 0o700 : 0o600)
  const hash = createHash('sha256')
  let offset = 0
  try {
    while (offset < expected.size) {
      if (signal?.aborted) {
        throw new SkillInstallOperationError(SKILL_INSTALL_CANCELLED_FAILURE)
      }
      const bytes = await reader.readExact(Math.min(64 * 1024, expected.size - offset))
      hash.update(bytes)
      let chunkOffset = 0
      while (chunkOffset < bytes.length) {
        const result = await handle.write(
          bytes,
          chunkOffset,
          bytes.length - chunkOffset,
          offset + chunkOffset
        )
        if (result.bytesWritten === 0) {
          throw new Error('skill-package-extraction-write-failed')
        }
        chunkOffset += result.bytesWritten
      }
      offset += bytes.length
    }
  } finally {
    await handle.close()
  }
  if (hash.digest('hex') !== expected.sha256) {
    throw new Error('skill-package-file-digest-mismatch')
  }
  await consumeZeroPadding(reader, expected.size)
}

function observedFilesMatch(
  observed: ObservedSkillPackage,
  manifest: SkillPackageManifestV1
): boolean {
  return (
    observed.observedDigest === manifest.packageDigest &&
    observed.files.length === manifest.files.length &&
    observed.files.every((actual, index) => {
      const expected = manifest.files[index]
      return (
        actual.path === expected.path &&
        actual.size === expected.size &&
        actual.executable === expected.executable &&
        actual.classification === expected.classification &&
        actual.exactSha256 === expected.sha256 &&
        actual.identitySha256 === expected.identitySha256
      )
    })
  )
}

async function readManifest(reader: TarByteReader): Promise<SkillPackageManifestV1> {
  const header = parseSkillTarHeader(await reader.readExact(SKILL_TAR_BLOCK_BYTES))
  if (
    !header ||
    header.path !== 'manifest.json' ||
    header.executable ||
    header.size > SKILL_PACKAGE_MAX_MANIFEST_BYTES
  ) {
    throw new Error('skill-package-manifest-envelope-invalid')
  }
  const bytes = await reader.readExact(header.size)
  await consumeZeroPadding(reader, header.size)
  try {
    return parseSkillPackageManifest(JSON.parse(bytes.toString('utf8')))
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error('skill-package-manifest-invalid')
    }
    throw error
  }
}

async function requireArchiveEnd(reader: TarByteReader): Promise<void> {
  for (let index = 0; index < 2; index += 1) {
    const block = await reader.readExact(SKILL_TAR_BLOCK_BYTES)
    if (!block.every((byte) => byte === 0)) {
      throw new Error('skill-package-tar-trailing-entry')
    }
  }
  for (;;) {
    const block = await reader.readExactOrNull(SKILL_TAR_BLOCK_BYTES)
    if (!block) {
      return
    }
    if (!block.every((byte) => byte === 0)) {
      throw new Error('skill-package-tar-trailing-data')
    }
  }
}

export async function extractSkillPackageArchive(input: {
  archivePath: string
  destinationDirectory: string
  expectedArchiveSha256?: string
  expectedPackageDigest?: string
  expectedPackageId?: string
  expectedVersionId?: string
  filesystem?: SkillInstallFilesystem
  signal?: AbortSignal
}): Promise<SkillPackageExtractionResult> {
  const filesystem = input.filesystem ?? nativeSkillInstallFilesystem
  const archive = await openSkillTarGzip(input.archivePath)
  let destinationCreated = false
  try {
    if (input.signal?.aborted) {
      throw new SkillInstallOperationError(SKILL_INSTALL_CANCELLED_FAILURE)
    }
    const manifest = await readManifest(archive.reader)
    if (
      (input.expectedPackageDigest && manifest.packageDigest !== input.expectedPackageDigest) ||
      (input.expectedPackageId && manifest.packageId !== input.expectedPackageId) ||
      (input.expectedVersionId && manifest.versionId !== input.expectedVersionId)
    ) {
      throw new Error('skill-package-identity-mismatch')
    }
    await mkdir(input.destinationDirectory, { mode: 0o700 })
    destinationCreated = true
    const skillDirectory = join(input.destinationDirectory, 'skill')
    await mkdir(skillDirectory, { mode: 0o700 })
    for (const expected of manifest.files) {
      if (input.signal?.aborted) {
        throw new SkillInstallOperationError(SKILL_INSTALL_CANCELLED_FAILURE)
      }
      const header = parseSkillTarHeader(await archive.reader.readExact(SKILL_TAR_BLOCK_BYTES))
      if (
        !header ||
        header.path !== `skill/${expected.path}` ||
        header.size !== expected.size ||
        header.executable !== expected.executable
      ) {
        throw new Error('skill-package-file-envelope-mismatch')
      }
      await extractFile(
        archive.reader,
        join(skillDirectory, ...expected.path.split('/')),
        expected,
        input.signal
      )
    }
    await requireArchiveEnd(archive.reader)
    if (input.signal?.aborted) {
      throw new SkillInstallOperationError(SKILL_INSTALL_CANCELLED_FAILURE)
    }
    const archiveIdentity = await archive.archiveIdentity
    if (
      input.expectedArchiveSha256 &&
      archiveIdentity.archiveSha256 !== input.expectedArchiveSha256
    ) {
      throw new Error('skill-package-archive-digest-mismatch')
    }
    await filesystem.prepareExtractedSkill(skillDirectory, manifest)
    const observed = await filesystem.observeSkill(skillDirectory, manifest.files)
    if (!observedFilesMatch(observed, manifest)) {
      throw new Error('skill-package-extracted-identity-mismatch')
    }
    const summary = summarizeSkillMarkdown(await readFile(join(skillDirectory, 'SKILL.md'), 'utf8'))
    if (summary.name !== manifest.name) {
      throw new Error('skill-package-skill-name-mismatch')
    }
    return { manifest, skillDirectory, ...archiveIdentity }
  } catch (error) {
    const failure = normalizeArchiveReadError(error)
    archive.abort(failure)
    await archive.archiveIdentity.catch(() => undefined)
    if (destinationCreated) {
      await rm(input.destinationDirectory, { recursive: true, force: true })
    }
    throw failure
  }
}
