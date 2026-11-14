import { mkdir } from 'node:fs/promises'
import type { SkillPackageManifestV1 } from '../../../shared/skill-package-manifest'
import { extractSkillPackageArchive } from '../package-archive/skill-package-extraction'
import type { LocalSkillInstallInput } from './skill-install-transaction'

export type LocalExtractedSkillPackage = {
  extractionPath: string
  manifest: SkillPackageManifestV1
  archiveSha256: string
}

export async function inspectExtractedPackage(
  input: LocalSkillInstallInput,
  extractionPath: string
): Promise<LocalExtractedSkillPackage> {
  await mkdir(input.destinationRoot, { recursive: true })
  const extracted = await extractSkillPackageArchive({
    archivePath: input.archivePath,
    destinationDirectory: extractionPath,
    expectedArchiveSha256: input.expectedArchiveSha256,
    expectedPackageDigest: input.expectedPackageDigest,
    expectedPackageId: input.expectedPackageId,
    expectedVersionId: input.expectedVersionId,
    filesystem: input.filesystem,
    signal: input.signal
  })
  return { extractionPath, manifest: extracted.manifest, archiveSha256: extracted.archiveSha256 }
}
