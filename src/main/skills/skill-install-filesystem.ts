import { rm } from 'node:fs/promises'
import type { SkillPackageManifestV1 } from '../../shared/skill-package-manifest'
import { renameSkillPathWithWindowsRetry } from './skill-filesystem-retry'
import {
  SKILL_PACKAGE_OBSERVATION_LIMITS,
  observeSkillPackage,
  type ObservedSkillPackage
} from './skill-package-identity'

export type SkillInstalledFileMode = { path: string; executable: boolean }

export type SkillInstallFilesystem = {
  authorizeRoots?(paths: readonly string[]): void
  prepareExtractedSkill(path: string, manifest: SkillPackageManifestV1): Promise<void>
  observeSkill(
    path: string,
    files?: readonly SkillInstalledFileMode[]
  ): Promise<ObservedSkillPackage>
  rename(source: string, target: string): Promise<void>
  remove(path: string): Promise<void>
  createAlias?(canonicalPath: string, destinationPath: string): Promise<void>
  aliasTargets?(canonicalPath: string, destinationPath: string): Promise<boolean>
}

export const nativeSkillInstallFilesystem: SkillInstallFilesystem = {
  prepareExtractedSkill: async () => undefined,
  observeSkill: (path, files) =>
    observeSkillPackage(
      path,
      SKILL_PACKAGE_OBSERVATION_LIMITS,
      process.platform === 'win32' && files
        ? new Set(files.filter((file) => file.executable).map((file) => file.path))
        : undefined
    ),
  rename: renameSkillPathWithWindowsRetry,
  remove: (path) => rm(path, { recursive: true, force: true })
}
